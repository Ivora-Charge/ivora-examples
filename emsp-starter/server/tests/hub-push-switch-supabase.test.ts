import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { ClientOptions } from "@/lib/ocpi/client";
import { setHubPushMode } from "@/lib/ocpi/hub";
import { SupabasePeerStore } from "@/lib/ocpi/store-supabase";
import { encryptToken } from "@/lib/ocpi/tokens";
import { pushToken, retryPendingPushes } from "@/lib/tokens/push";
import type { NewDriverToken } from "@/lib/tokens/store";
import { SupabaseTokenStore } from "@/lib/tokens/store-supabase";
import { LIVE_ENV } from "./support/network";
import { applyMigrations, migratedDatabase } from "./support/pglite";
import { pgliteRest } from "./support/pglite-rest";

/**
 * The hub push-mode switch on PGlite (202611250001_hub_push_switch): the mode change,
 * the catch-up and the audit row are one transaction, and a push that started before
 * the switch cannot clear what the switch owes.
 */
// A new hub per test: the audit log is append-only, so it is told apart by subject.
let HUB = "";
const URL = "https://db.example.test";
const KEY = "test-service-role-key";
const NOW = "2026-11-25T12:00:00.000Z";
let db: PGlite;
let peers: SupabasePeerStore;
let tokens: SupabaseTokenStore;

beforeAll(async () => {
  db = await migratedDatabase();
  peers = new SupabasePeerStore(URL, KEY, pgliteRest(db));
  tokens = new SupabaseTokenStore(URL, KEY, pgliteRest(db));
}, 60_000);
afterAll(async () => {
  await db?.close();
});

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

/**
 * A registered hub in per-party mode that lists a tokens Receiver, with `parties`
 * trusted behind it.
 */
async function addHub(
  on: PGlite,
  id: string,
  { ciphertext = "v1:x", parties = [] as string[], roles = ["HUB"] } = {},
) {
  await on.query(
    `insert into public.emsp_ocpi_peers
       (id, label, direction, status, token_ciphertext, registered_at, endpoints, roles, hub_push_mode, hub_parties)
     values ($1, 'Hub', 'outbound', 'registered', $4, now(), $2, $3, 'per_party', $5)`,
    [
      id,
      JSON.stringify([
        {
          identifier: "tokens",
          role: "RECEIVER",
          url: "https://hub.example.test/ocpi/2.2.1/tokens",
        },
      ]),
      JSON.stringify(
        roles.map((role) => ({
          role,
          country_code: "ZZ",
          party_id: "HUB",
          business_details: { name: "Hub" },
        })),
      ),
      ciphertext,
      JSON.stringify(
        parties.map((partyId) => ({
          countryCode: "DE",
          partyId,
          status: "trusted",
          source: "admin",
        })),
      ),
    ],
  );
}

beforeEach(async () => {
  HUB = randomUUID();
  await db.exec(
    "delete from public.emsp_token_pushes; delete from public.emsp_tokens; delete from public.emsp_ocpi_peers;",
  );
  await addHub(db, HUB);
});

/** Live mode, and the hub's credentials encrypted under the test key. */
async function goLive(on: PGlite, id: string) {
  Object.assign(process.env, LIVE_ENV);
  delete process.env.DEMO_MODE;
  await on.query(
    "update public.emsp_ocpi_peers set token_ciphertext = $2 where id = $1",
    [id, encryptToken("hub-credentials-token", id)],
  );
}

type Sent = { method: string; path: string; to: string };
/**
 * The hub's Tokens Receiver: answers every request with OCPI success and records who
 * it was addressed to. `before` runs before the first answer (a test can switch the
 * mode while a push is under way).
 */
function fakeHub(before?: () => Promise<void>) {
  const sent: Sent[] = [];
  let first = before;
  const client: ClientOptions = {
    retries: 0,
    transport: async (url, init) => {
      const headers = new Headers(init.headers);
      sent.push({
        method: String(init.method),
        path: new globalThis.URL(url).pathname,
        to: `${headers.get("OCPI-to-country-code")}/${headers.get("OCPI-to-party-id")}`,
      });
      if (first) {
        const run = first;
        first = undefined;
        await run();
      }
      return Response.json({
        status_code: 1000,
        status_message: "Success",
        timestamp: new Date().toISOString(),
      });
    },
  };
  return { sent, client };
}

const token = (uid: string): NewDriverToken => ({
  countryCode: "NL",
  partyId: "ABC",
  uid,
  type: "RFID",
  contractId: `NLABCC${uid}`,
  driverRef: `driver-${uid}`,
  visualNumber: null,
  groupId: "NLABCC12345678",
  issuer: "Example",
  whitelist: "ALLOWED",
  language: null,
  expiresAt: null,
  lastUpdated: "2026-11-25T10:00:00.000Z",
});

const owed = async () =>
  (
    await db.query<{ token_id: string; push_gen: number }>(
      "select token_id, push_gen from public.emsp_token_pushes where peer_id = $1 order by token_id",
      [HUB],
    )
  ).rows;
const audits = async () =>
  (
    await db.query<{ details: unknown; actor: string }>(
      "select actor, details from public.emsp_audit_log where action = 'ocpi.hub.push_mode_set' and subject_id = $1",
      [HUB],
    )
  ).rows;
const modeOf = async () =>
  (
    await db.query<{ hub_push_mode: string; push_gen: number }>(
      "select hub_push_mode, push_gen from public.emsp_ocpi_peers where id = $1",
      [HUB],
    )
  ).rows[0];

describe("hub push mode switch on PGlite", () => {
  it("owes every token, blocked ones too, and audits, in one step", async () => {
    const a = (await tokens.insertToken(token("0A0B0C01")))!;
    const b = (await tokens.insertToken(token("0A0B0C02")))!;
    await tokens.updateToken(
      b.id,
      { status: "blocked", lastUpdated: "2026-11-25T11:00:00.000Z" },
      b.revision,
    );
    await db.query("delete from public.emsp_token_pushes");

    const hub = (await peers.getPeer(HUB))!;
    const result = await peers.setHubPushMode({
      peerId: HUB,
      mode: "hub",
      ifRev: hub.rev,
      now: NOW,
      actor: "admin:test",
    });
    expect(result).toMatchObject({
      from: "per_party",
      owed: 2,
      peer: { hubPushMode: "hub", pushGen: 1 },
    });
    expect((await owed()).map((r) => r.token_id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(await audits()).toEqual([
      {
        actor: "admin:test",
        details: { mode: "hub", from: "per_party", owed: 2 },
      },
    ]);
    const due = await tokens.duePushes(NOW, 10);
    expect(due).toHaveLength(2);
    expect(due.every((p) => p.pushGen === 1 && p.nextAttemptAt === NOW)).toBe(
      true,
    );

    // The same switch again, from the same revision: nothing more is owed or audited.
    expect(
      await peers.setHubPushMode({
        peerId: HUB,
        mode: "hub",
        ifRev: hub.rev,
        now: NOW,
        actor: "admin:test",
      }),
    ).toBeNull();
    expect(await audits()).toHaveLength(1);
  });

  it("owes nothing when switching back, but still audits and raises the generation", async () => {
    await db.query(
      "update public.emsp_ocpi_peers set hub_push_mode = 'hub' where id = $1",
      [HUB],
    );
    await tokens.insertToken(token("0A0B0C01"));
    await db.query("delete from public.emsp_token_pushes");
    const hub = (await peers.getPeer(HUB))!;
    expect(
      await peers.setHubPushMode({
        peerId: HUB,
        mode: "per_party",
        ifRev: hub.rev,
        now: NOW,
        actor: "admin",
      }),
    ).toMatchObject({ from: "hub", owed: 0 });
    expect(await owed()).toEqual([]);
    expect(await audits()).toHaveLength(1);
    expect((await modeOf()).push_gen).toBe(1);
  });

  it("writes nothing when the peer changed since it was read", async () => {
    await tokens.insertToken(token("0A0B0C01"));
    const hub = (await peers.getPeer(HUB))!;
    await peers.updatePeer(HUB, { label: "Renamed" });
    expect(
      await peers.setHubPushMode({
        peerId: HUB,
        mode: "hub",
        ifRev: hub.rev,
        now: NOW,
        actor: "admin",
      }),
    ).toBeNull();
    expect(await modeOf()).toMatchObject({ hub_push_mode: "per_party" });
    expect(await audits()).toEqual([]);
  });

  it("a switch that fails part way leaves no mode change, no catch-up and no audit row", async () => {
    await tokens.insertToken(token("0A0B0C01"));
    await db.query("delete from public.emsp_token_pushes");
    const hub = (await peers.getPeer(HUB))!;
    // The audit row is the last write: an actor the log refuses undoes the others.
    await expect(
      peers.setHubPushMode({
        peerId: HUB,
        mode: "hub",
        ifRev: hub.rev,
        now: NOW,
        actor: "",
      }),
    ).rejects.toThrow();
    expect(await modeOf()).toEqual({
      hub_push_mode: "per_party",
      push_gen: 0,
    });
    expect(await owed()).toEqual([]);
    expect(await audits()).toEqual([]);
    // Trying again completes, owing the set once.
    expect(
      (
        await setHubPushMode(HUB, "hub", {
          store: peers,
          now: () => new Date(NOW),
        })
      ).owed,
    ).toBe(1);
    expect(await audits()).toHaveLength(1);
  });

  it("a push that started before the switch cannot clear what the switch owes", async () => {
    const t = (await tokens.insertToken(token("0A0B0C01")))!;
    // The change owed the token in generation 0; a per-party push starts under it.
    const started = (await peers.getPeer(HUB))!;
    expect(started.pushGen).toBe(0);
    expect(await owed()).toHaveLength(1);
    await setHubPushMode(HUB, "hub", {
      store: peers,
      now: () => new Date(NOW),
    });
    // The old push lands: the row it would clear is owed in the new generation.
    await tokens.pushSucceeded(HUB, t.id, t.lastUpdated, started.pushGen);
    expect(await owed()).toEqual([{ token_id: t.id, push_gen: 1 }]);
    // The push the retry job sends under the new generation clears it.
    const now = (await peers.getPeer(HUB))!;
    await tokens.pushSucceeded(HUB, t.id, t.lastUpdated, now.pushGen);
    expect(await owed()).toEqual([]);
  });

  it("a change after the switch is owed in the new generation", async () => {
    const t = (await tokens.insertToken(token("0A0B0C01")))!;
    await setHubPushMode(HUB, "hub", {
      store: peers,
      now: () => new Date(NOW),
    });
    await tokens.updateToken(
      t.id,
      { status: "blocked", lastUpdated: "2026-11-25T13:00:00.000Z" },
      t.revision,
    );
    expect(await owed()).toEqual([{ token_id: t.id, push_gen: 1 }]);
  });

  it("a failed push does not lower the generation", async () => {
    const t = (await tokens.insertToken(token("0A0B0C01")))!;
    await setHubPushMode(HUB, "hub", {
      store: peers,
      now: () => new Date(NOW),
    });
    await tokens.pushFailed({
      peerId: HUB,
      tokenId: t.id,
      tokenLastUpdated: t.lastUpdated,
      error: "HTTP 503",
      now: NOW,
    });
    expect(await owed()).toEqual([{ token_id: t.id, push_gen: 1 }]);
  });

  it("refuses a peer that is not a roaming hub, and writes nothing", async () => {
    const cpo = randomUUID();
    await addHub(db, cpo, { roles: ["CPO"] });
    await tokens.insertToken(token("0A0B0C01"));
    await db.query("delete from public.emsp_token_pushes");
    const peer = (await peers.getPeer(cpo))!;
    await expect(
      peers.setHubPushMode({
        peerId: cpo,
        mode: "hub",
        ifRev: peer.rev,
        now: NOW,
        actor: "admin",
      }),
    ).rejects.toThrow();
    expect(await peers.getPeer(cpo)).toMatchObject({
      hubPushMode: "per_party",
      pushGen: 0,
    });
    expect(
      (await db.query("select 1 from public.emsp_token_pushes")).rows,
    ).toEqual([]);
  });

  it("the outbox trigger reads the peer's generation under a share lock", async () => {
    // PGlite has one connection, so two transactions cannot interleave here: check the
    // lock that makes a token change wait for a concurrent switch.
    const [{ src }] = (
      await db.query<{ src: string }>(
        "select prosrc as src from pg_proc where proname = 'emsp_tokens_owe_push'",
      )
    ).rows;
    expect(src).toMatch(/for share of p/i);
  });

  it("the switch locks the peer FOR NO KEY UPDATE, so an outbox insert's FK lock can still go", async () => {
    const [{ src }] = (
      await db.query<{ src: string }>(
        "select prosrc as src from pg_proc where proname = 'emsp_ocpi_hub_set_push_mode'",
      )
    ).rows;
    expect(src).toMatch(/for no key update;/i);
    expect(src).not.toMatch(/for update;/i);
  });

  it("a retry round under way during a switch cannot clear what the switch owes", async () => {
    await db.query(
      "update public.emsp_ocpi_peers set hub_parties = $2 where id = $1",
      [
        HUB,
        JSON.stringify([
          {
            countryCode: "DE",
            partyId: "AAA",
            status: "trusted",
            source: "admin",
          },
        ]),
      ],
    );
    await goLive(db, HUB);
    const t = (await tokens.insertToken(token("0A0B0C01")))!;
    expect(await owed()).toEqual([{ token_id: t.id, push_gen: 0 }]);
    // The round reads the hub in per-party mode; the switch lands while its push is
    // on the wire.
    const hub = fakeHub(async () => {
      await setHubPushMode(HUB, "hub", {
        store: peers,
        now: () => new Date(NOW),
      });
    });
    const deps = {
      tokens,
      peers,
      client: hub.client,
      now: () => new Date(NOW),
    };
    expect(await retryPendingPushes(deps)).toEqual({
      sent: 1,
      failed: 0,
      dropped: 0,
    });
    expect(hub.sent.map((r) => r.to)).toEqual(["DE/AAA"]);
    // Still owed, in the new generation, and the next round sends it to the hub's party.
    expect(await owed()).toEqual([{ token_id: t.id, push_gen: 1 }]);
    expect(await retryPendingPushes(deps)).toMatchObject({ sent: 1 });
    expect(hub.sent.map((r) => r.to)).toEqual(["DE/AAA", "ZZ/HUB"]);
    expect(await owed()).toEqual([]);
  });

  it("hub, per party, then hub again: each switch raises the generation and the last catches up", async () => {
    await db.query(
      "update public.emsp_ocpi_peers set hub_push_mode = 'hub' where id = $1",
      [HUB],
    );
    const t = (await tokens.insertToken(token("0A0B0C01")))!;
    await db.query("delete from public.emsp_token_pushes");
    const deps = { store: peers, now: () => new Date(NOW) };
    expect(await setHubPushMode(HUB, "per_party", deps)).toMatchObject({
      changed: true,
      owed: 0,
    });
    expect(await owed()).toEqual([]);
    expect(await setHubPushMode(HUB, "hub", deps)).toMatchObject({
      changed: true,
      owed: 1,
    });
    expect(await modeOf()).toEqual({ hub_push_mode: "hub", push_gen: 2 });
    expect(await owed()).toEqual([{ token_id: t.id, push_gen: 2 }]);
    expect(
      (await audits()).map((a) => (a.details as { mode: string }).mode),
    ).toEqual(["per_party", "hub"]);
  });
});

describe("token pushes before the 202611250001 migration", () => {
  const BEFORE = "202611250001_hub_push_switch.sql";
  let old: PGlite;
  let oldPeers: SupabasePeerStore;
  let oldTokens: SupabaseTokenStore;
  let hubId = "";

  beforeAll(async () => {
    old = await migratedDatabase({ before: BEFORE });
    oldPeers = new SupabasePeerStore(URL, KEY, pgliteRest(old));
    oldTokens = new SupabaseTokenStore(URL, KEY, pgliteRest(old));
  }, 60_000);
  afterAll(async () => {
    await old?.close();
  });
  beforeEach(async () => {
    hubId = randomUUID();
    await old.exec(
      "delete from public.emsp_token_pushes; delete from public.emsp_tokens; delete from public.emsp_ocpi_peers;",
    );
    await addHub(old, hubId, { parties: ["AAA"] });
    await goLive(old, hubId);
  });
  const pending = async () =>
    (
      await old.query<{ peer_id: string; token_id: string }>(
        "select peer_id, token_id from public.emsp_token_pushes order by peer_id",
      )
    ).rows;

  it("has no push generation column", async () => {
    expect(
      (
        await old.query(
          "select 1 from information_schema.columns where table_name = 'emsp_token_pushes' and column_name = 'push_gen'",
        )
      ).rows,
    ).toEqual([]);
    expect((await oldPeers.getPeer(hubId))!.pushGen).toBeNull();
  });

  it("a retry round drops a push owed to a peer that is gone, without failing", async () => {
    const t = (await oldTokens.insertToken(token("0A0B0C01")))!;
    // A push owed to a peer that is no longer a tokens Receiver: the round drops it.
    await old.query(
      "update public.emsp_ocpi_peers set status = 'unregistered' where id = $1",
      [hubId],
    );
    expect(await pending()).toEqual([{ peer_id: hubId, token_id: t.id }]);
    const hub = fakeHub();
    expect(
      await retryPendingPushes({
        tokens: oldTokens,
        peers: oldPeers,
        client: hub.client,
        now: () => new Date(NOW),
      }),
    ).toEqual({ sent: 0, failed: 0, dropped: 1 });
    expect(await pending()).toEqual([]);
    expect(hub.sent).toEqual([]);
  });

  it("a push and a retry both land and clear what is owed", async () => {
    const hub = fakeHub();
    const deps = {
      tokens: oldTokens,
      peers: oldPeers,
      client: hub.client,
      now: () => new Date(NOW),
    };
    const a = (await oldTokens.insertToken(token("0A0B0C01")))!;
    expect(await pushToken(a, { method: "PUT" }, deps)).toMatchObject([
      { ok: true },
    ]);
    expect(await pending()).toEqual([]);

    const b = (await oldTokens.insertToken(token("0A0B0C02")))!;
    expect(await pending()).toEqual([{ peer_id: hubId, token_id: b.id }]);
    expect(await retryPendingPushes(deps)).toEqual({
      sent: 1,
      failed: 0,
      dropped: 0,
    });
    expect(await pending()).toEqual([]);
    expect(hub.sent.map((r) => r.to)).toEqual(["DE/AAA", "DE/AAA"]);
  });

  it("refuses the switch as a pending migration, and works once it is applied", async () => {
    const peer = (await oldPeers.getPeer(hubId))!;
    await expect(
      setHubPushMode(hubId, "hub", { store: oldPeers }),
    ).rejects.toMatchObject({ code: expect.any(String) });
    expect((await oldPeers.getPeer(hubId))!.hubPushMode).toBe("per_party");
    expect((await oldPeers.getPeer(hubId))!.rev).toBe(peer.rev);
    await applyMigrations(old);
    expect(
      await setHubPushMode(hubId, "hub", {
        store: oldPeers,
        now: () => new Date(NOW),
      }),
    ).toMatchObject({ changed: true });
  });
});
