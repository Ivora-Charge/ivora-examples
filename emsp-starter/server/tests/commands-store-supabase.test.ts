import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { startSession, type CommandDeps } from "@/lib/commands/manage";
import type { NewCommand } from "@/lib/commands/store";
import { SupabaseCommandStore } from "@/lib/commands/store-supabase";
import { DEMO_PEER_ID } from "@/lib/locations/registry";
import { locationAppId } from "@/lib/locations/search";
import { MemoryLocationStore } from "@/lib/locations/store";
import { sampleLocations } from "@/lib/mock-cpo/sample-data";
import { MemoryPeerStore } from "@/lib/ocpi/store";
import { createAppToken } from "@/lib/tokens/manage";
import { MemoryTokenStore } from "@/lib/tokens/store";
import { asRole, migratedDatabase } from "./support/pglite";
import { pgliteRest } from "./support/pglite-rest";

const PEER = "8b0f0b5e-3c47-4c1e-9d55-4f1f0f8d2b11";
const saved = { ...process.env };
let db: PGlite;
let store: SupabaseCommandStore;

beforeAll(async () => {
  db = await migratedDatabase();
  store = new SupabaseCommandStore(
    "https://db.example.test",
    "test-service-role-key",
    pgliteRest(db),
  );
}, 60_000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec(
    "delete from public.emsp_commands; delete from public.emsp_ocpi_peers;",
  );
  await db.query(
    "insert into public.emsp_ocpi_peers (id, label, direction) values ($1, 'CPO', 'outbound')",
    [PEER],
  );
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const start = (over: Partial<NewCommand> = {}): NewCommand => ({
  type: "START_SESSION",
  driverRef: "driver-1",
  requestId: "req-000001",
  peerId: PEER,
  toCountryCode: "ZZ",
  toPartyId: "MCK",
  locationId: "LOC1",
  evseUid: "LOC1-1",
  connectorId: "1",
  sessionId: null,
  authorizationReference: crypto.randomUUID(),
  deadlineAt: "2026-10-21T10:02:00.000Z",
  ...over,
});

const stop = (over: Partial<NewCommand> = {}): NewCommand =>
  start({
    type: "STOP_SESSION",
    locationId: null,
    evseUid: null,
    connectorId: null,
    sessionId: "SESSION-1",
    authorizationReference: null,
    ...over,
  });

describe("Supabase command store on PGlite", () => {
  it("claims a request once, replays it, and keeps one open start per driver", async () => {
    const first = await store.claim(start());
    expect(first.outcome).toBe("created");
    expect(first.command).toMatchObject({
      status: "claimed",
      driverRef: "driver-1",
      requestId: "req-000001",
      outcomeUncertain: false,
      deadlineAt: "2026-10-21T10:02:00.000Z",
      sentAt: null,
    });
    expect(await store.claim(start())).toEqual({
      outcome: "replayed",
      command: first.command,
    });
    const busy = await store.claim(start({ requestId: "req-000002" }));
    expect(busy).toMatchObject({
      outcome: "busy",
      command: { id: first.command.id },
    });
    expect((await store.claim(start({ driverRef: "driver-2" }))).outcome).toBe(
      "created",
    );
    // Once it ends, the driver may start again.
    await store.transition(
      first.command.id,
      ["claimed"],
      { status: "failed" },
      "2026-10-21T10:00:01.000Z",
    );
    expect(
      (await store.claim(start({ requestId: "req-000002" }))).outcome,
    ).toBe("created");
  });

  it("keeps one open stop per session", async () => {
    expect((await store.claim(stop())).outcome).toBe("created");
    expect(
      (
        await store.claim(
          stop({ driverRef: "driver-2", requestId: "req-200000" }),
        )
      ).outcome,
    ).toBe("busy");
    expect(
      (await store.claim(stop({ requestId: "req-000003", sessionId: "S-2" })))
        .outcome,
    ).toBe("created");
  });

  it("changes a command only from the states it names, and finds overdue ones", async () => {
    const { command } = await store.claim(start());
    const sending = await store.transition(
      command.id,
      ["claimed"],
      {
        status: "sending",
        holdRef: "hold-1",
        sentAt: "2026-10-21T10:00:00.000Z",
        deadlineAt: "2026-10-21T10:03:00.000Z",
      },
      "2026-10-21T10:00:00.000Z",
    );
    expect(sending).toMatchObject({ status: "sending", holdRef: "hold-1" });
    expect(
      await store.transition(
        command.id,
        ["claimed"],
        { status: "failed" },
        "2026-10-21T10:00:01.000Z",
      ),
    ).toBeNull();
    expect(await store.overdue("2026-10-21T10:02:59.000Z", 10)).toEqual([]);
    expect(
      (await store.overdue("2026-10-21T10:03:00.000Z", 10)).map((c) => c.id),
    ).toEqual([command.id]);
    const done = await store.transition(
      command.id,
      ["sending", "accepted"],
      {
        status: "succeeded",
        responseResult: "ACCEPTED",
        responseTimeoutS: 30,
        result: "ACCEPTED",
        peerMessage: "Started",
        finishedAt: "2026-10-21T10:00:05.000Z",
      },
      "2026-10-21T10:00:05.000Z",
    );
    expect(done).toMatchObject({
      status: "succeeded",
      result: "ACCEPTED",
      updatedAt: "2026-10-21T10:00:05.000Z",
    });
    expect(await store.overdue("2026-10-21T11:00:00.000Z", 10)).toEqual([]);
    expect(
      await store.getByAuthorizationReference(command.authorizationReference!),
    ).toEqual(done);
    await store.transition(
      command.id,
      ["succeeded"],
      { sessionId: "SESSION-1" },
      "2026-10-21T10:00:06.000Z",
    );
    expect((await store.findStartBySession(PEER, "SESSION-1"))?.id).toBe(
      command.id,
    );
    expect(await store.findStartBySession(PEER, "SESSION-2")).toBeNull();
  });

  it("refuses values outside the table's checks", async () => {
    for (const bad of [
      start({ requestId: "short" }),
      start({ type: "UNLOCK_CONNECTOR" as never }),
      start({ locationId: null }),
      start({ evseUid: null }),
      stop({ sessionId: null }),
      start({ toCountryCode: "zz" }),
    ])
      await expect(store.claim(bad)).rejects.toThrow(/Database request failed/);
    const { command } = await store.claim(start());
    await expect(
      store.transition(
        command.id,
        ["claimed"],
        { result: "MAYBE" as never },
        "2026-10-21T10:00:00.000Z",
      ),
    ).rejects.toThrow(/Database request failed/);
  });

  it(
    "claims one command when the same tap, or many taps, arrive at once",
    { timeout: 20_000 },
    async () => {
      const same = await Promise.all(
        Array.from({ length: 12 }, () => store.claim(start())),
      );
      expect(same.filter((r) => r.outcome === "created")).toHaveLength(1);
      expect(new Set(same.map((r) => r.command.id)).size).toBe(1);

      const taps = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          store.claim(
            start({
              driverRef: "driver-2",
              requestId: `tap-${String(i).padStart(6, "0")}`,
            }),
          ),
        ),
      );
      expect(taps.filter((r) => r.outcome === "created")).toHaveLength(1);
      expect(taps.filter((r) => r.outcome === "busy")).toHaveLength(11);
      const { rows } = await db.query(
        "select count(*)::int as n from public.emsp_commands",
      );
      expect(rows).toEqual([{ n: 2 }]);
    },
  );

  it(
    "lets one of many parallel transitions win",
    { timeout: 20_000 },
    async () => {
      const { command } = await store.claim(start());
      await store.transition(
        command.id,
        ["claimed"],
        { status: "accepted" },
        "2026-10-21T10:00:00.000Z",
      );
      const results = await Promise.all(
        (["succeeded", "failed", "timed_out", "not_supported"] as const).map(
          (status) =>
            store.transition(
              command.id,
              ["sending", "accepted"],
              { status },
              "2026-10-21T10:00:01.000Z",
            ),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    },
  );

  it(
    "sends one start when a tap arrives many times at once (demo mode, nothing sent)",
    { timeout: 20_000 },
    async () => {
      process.env.DEMO_MODE = "true";
      vi.spyOn(console, "error").mockImplementation(() => {});
      // Demo mode: the demo CPO's ID is not a peer row, so give the store one.
      await db.query(
        "insert into public.emsp_ocpi_peers (id, label, direction) values ($1, 'Demo', 'outbound')",
        ["00000000-0000-4000-8000-00000000d3e0"],
      );
      const peers = new MemoryPeerStore();
      const tokens = new MemoryTokenStore();
      await createAppToken(
        { driverRef: "driver-1" },
        { tokens, peers, actor: "test" },
      );
      const locations = new MemoryLocationStore();
      await locations.saveLocations(
        DEMO_PEER_ID,
        sampleLocations({ countryCode: "ZZ", partyId: "MCK" }, 1),
        "2026-10-21T10:00:00.000Z",
      );
      const holds: string[] = [];
      const deps: CommandDeps = {
        commands: {
          claim: (c) =>
            store.claim({
              ...c,
              peerId: "00000000-0000-4000-8000-00000000d3e0",
            }),
          get: (id) => store.get(id),
          getByAuthorizationReference: (r) =>
            store.getByAuthorizationReference(r),
          findStartBySession: (p, s) => store.findStartBySession(p, s),
          transition: (id, from, patch, now) =>
            store.transition(id, from, patch, now),
          overdue: (now, limit) => store.overdue(now, limit),
        },
        peers,
        tokens,
        locations,
        preAuth: {
          async hold(c) {
            holds.push(c.id);
            return { ok: true, reference: null };
          },
          async release() {},
        },
      };
      const locationId = locationAppId({
        peerId: DEMO_PEER_ID,
        countryCode: "ZZ",
        partyId: "MCK",
        id: "LOC1",
      });
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          startSession(
            {
              driverRef: "driver-1",
              // Half the taps reuse one request ID, half bring their own.
              requestId: i % 2 ? "req-same-01" : `req-own-0${i}`,
              locationId,
              evseUid: "LOC1-1",
            },
            deps,
          ),
        ),
      );
      expect(results.filter((r) => r.state === "created")).toHaveLength(1);
      expect(holds).toHaveLength(1);
      const created = results.find((r) => r.state === "created")!;
      expect(created.command.status).toBe("succeeded");
    },
  );

  it("keeps commands away from anon and authenticated, and never deletable", async () => {
    for (const role of ["anon", "authenticated"] as const)
      await asRole(db, role, async () => {
        await expect(
          db.query("select * from public.emsp_commands"),
        ).rejects.toThrow(/permission denied/);
        await expect(
          db.query(
            "select * from public.emsp_command_claim('START_SESSION', 'd', 'req-000001', $1, 'ZZ', 'MCK', 'L', null, null, null, null, now())",
            [PEER],
          ),
        ).rejects.toThrow(/permission denied/);
      });
    await store.claim(start());
    await asRole(db, "service_role", async () => {
      await expect(
        db.query("delete from public.emsp_commands"),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
