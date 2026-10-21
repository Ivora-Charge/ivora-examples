import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { NewDriverToken } from "@/lib/tokens/store";
import { pushBackoffMs } from "@/lib/tokens/store";
import { SupabaseTokenStore } from "@/lib/tokens/store-supabase";
import { asRole, migratedDatabase } from "./support/pglite";
import { pgliteRest } from "./support/pglite-rest";

const PEER = "8b0f0b5e-3c47-4c1e-9d55-4f1f0f8d2b11";
let db: PGlite;
let store: SupabaseTokenStore;

beforeAll(async () => {
  db = await migratedDatabase();
  store = new SupabaseTokenStore(
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
    "delete from public.emsp_token_pushes; delete from public.emsp_tokens; delete from public.emsp_ocpi_peers;",
  );
  await db.query(
    "insert into public.emsp_ocpi_peers (id, label, direction) values ($1, 'CPO', 'outbound')",
    [PEER],
  );
});

const token = (over: Partial<NewDriverToken> = {}): NewDriverToken => ({
  countryCode: "NL",
  partyId: "ABC",
  uid: "0A0B0C0D",
  type: "RFID",
  contractId: "NLABCC12345678",
  driverRef: "driver-1",
  visualNumber: null,
  groupId: "NLABCC12345678",
  issuer: "Example",
  whitelist: "ALLOWED",
  language: null,
  expiresAt: null,
  lastUpdated: "2026-10-21T10:00:00.000Z",
  ...over,
});

describe("Supabase token store on PGlite", () => {
  it("inserts, refuses a second token with the same uid and type, and reads it back", async () => {
    const t = await store.insertToken(token());
    expect(t).toMatchObject({
      uid: "0A0B0C0D",
      status: "active",
      lastUpdated: "2026-10-21T10:00:00.000Z",
    });
    expect(await store.insertToken(token())).toBeNull();
    expect(await store.getToken("0A0B0C0D", "RFID")).toEqual(t);
    expect(await store.getTokenById(t!.id)).toEqual(t);
    expect(await store.getToken("0A0B0C0D", "APP_USER")).toBeNull();
  });

  it("allows one APP_USER token and one contract per driver", async () => {
    await store.insertToken(token({ type: "APP_USER", uid: "AAAA" }));
    await expect(
      store.insertToken(
        token({ type: "APP_USER", uid: "BBBB", contractId: "NLABCC99999999" }),
      ),
    ).rejects.toThrow(/Database request failed/);
    await expect(
      store.insertToken(
        token({ type: "APP_USER", uid: "CCCC", driverRef: "driver-2" }),
      ),
    ).rejects.toThrow(/Database request failed/);
    // RFID cards share the contract.
    expect(await store.insertToken(token({ uid: "DDDD" }))).not.toBeNull();
    expect((await store.listByDriver("driver-1")).map((t) => t.type)).toEqual([
      "APP_USER",
      "RFID",
    ]);
  });

  it("refuses values outside the table's checks", async () => {
    for (const bad of [
      token({ uid: "lower" }),
      token({ contractId: "NL-ABC-C12345678" }),
      token({ whitelist: "SOMETIMES" as never }),
      token({ type: "OTHER" as never }),
    ])
      await expect(store.insertToken(bad)).rejects.toThrow(
        /Database request failed/,
      );
  });

  it("changes a token only at the revision it read", async () => {
    const t = (await store.insertToken(token()))!;
    const blocked = await store.updateToken(
      t.id,
      { status: "blocked", lastUpdated: "2026-10-21T10:00:01.000Z" },
      t.revision,
    );
    expect(blocked).toMatchObject({
      status: "blocked",
      lastUpdated: "2026-10-21T10:00:01.000Z",
    });
    expect(blocked!.revision).not.toBe(t.revision);
    expect(
      await store.updateToken(
        t.id,
        { status: "active", lastUpdated: "2026-10-21T10:00:02.000Z" },
        t.revision,
      ),
    ).toBeNull();
  });

  it("pages by last_updated with date_from inclusive, date_to exclusive and a total", async () => {
    for (let i = 0; i < 5; i++)
      await store.insertToken(
        token({
          uid: `CARD${i}`,
          lastUpdated: `2026-10-21T10:0${i}:00.000Z`,
        }),
      );
    const page = await store.page({ offset: 1, limit: 2 });
    expect(page.total).toBe(5);
    expect(page.tokens.map((t) => t.uid)).toEqual(["CARD1", "CARD2"]);
    const window = await store.page({
      dateFrom: "2026-10-21T10:01:00.000Z",
      dateTo: "2026-10-21T10:03:00.000Z",
      offset: 0,
      limit: 100,
    });
    expect(window.total).toBe(2);
    expect(window.tokens.map((t) => t.uid)).toEqual(["CARD1", "CARD2"]);
  });

  it("lists active tokens past their expiry", async () => {
    await store.insertToken(
      token({ uid: "OLD", expiresAt: "2026-10-01T00:00:00.000Z" }),
    );
    await store.insertToken(
      token({ uid: "NEW", expiresAt: "2026-12-01T00:00:00.000Z" }),
    );
    await store.insertToken(token({ uid: "NONE" }));
    expect(
      (await store.listExpired("2026-10-21T00:00:00.000Z", 10)).map(
        (t) => t.uid,
      ),
    ).toEqual(["OLD"]);
  });

  it("queues failed pushes with backoff, and clears them only for the version owed", async () => {
    const t = (await store.insertToken(token()))!;
    const now = "2026-10-21T10:00:00.000Z";
    const fail = (lastUpdated: string, at = now) =>
      store.pushFailed({
        peerId: PEER,
        tokenId: t.id,
        tokenLastUpdated: lastUpdated,
        error: "PUT cpo.example.test/x failed with HTTP 503",
        now: at,
      });
    await fail("2026-10-21T10:00:05.000Z");
    expect(await store.duePushes(now, 10)).toEqual([]);
    const [first] = await store.duePushes("2026-10-21T11:00:00.000Z", 10);
    expect(first).toMatchObject({
      peerId: PEER,
      attempts: 1,
      nextAttemptAt: new Date(Date.parse(now) + pushBackoffMs(1)).toISOString(),
    });
    // An older version failing again keeps the newest owed, and backs off further.
    await fail("2026-10-21T10:00:01.000Z", "2026-10-21T10:01:00.000Z");
    const [second] = await store.duePushes("2026-10-21T11:00:00.000Z", 10);
    expect(second).toMatchObject({
      attempts: 2,
      tokenLastUpdated: "2026-10-21T10:00:05.000Z",
      nextAttemptAt: new Date(
        Date.parse("2026-10-21T10:01:00.000Z") + pushBackoffMs(2),
      ).toISOString(),
    });
    expect(await store.countPendingPushes(10)).toBe(1);
    await store.pushSucceeded(PEER, t.id, "2026-10-21T10:00:04.000Z");
    expect(await store.countPendingPushes(10)).toBe(1);
    await store.pushSucceeded(PEER, t.id, "2026-10-21T10:00:05.000Z");
    expect(await store.countPendingPushes(10)).toBe(0);
  });

  it("keeps tokens away from anon and authenticated, and never deletable", async () => {
    for (const role of ["anon", "authenticated"] as const)
      await asRole(db, role, async () => {
        await expect(
          db.query("select * from public.emsp_tokens"),
        ).rejects.toThrow(/permission denied/);
        await expect(
          db.query("select * from public.emsp_token_pushes"),
        ).rejects.toThrow(/permission denied/);
      });
    await store.insertToken(token());
    await asRole(db, "service_role", async () => {
      await expect(db.query("delete from public.emsp_tokens")).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});
