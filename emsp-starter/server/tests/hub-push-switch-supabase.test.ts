import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { setHubPushMode } from "@/lib/ocpi/hub";
import { SupabasePeerStore } from "@/lib/ocpi/store-supabase";
import type { NewDriverToken } from "@/lib/tokens/store";
import { SupabaseTokenStore } from "@/lib/tokens/store-supabase";
import { migratedDatabase } from "./support/pglite";
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

beforeEach(async () => {
  HUB = randomUUID();
  await db.exec(
    "delete from public.emsp_token_pushes; delete from public.emsp_tokens; delete from public.emsp_ocpi_peers;",
  );
  // A registered hub in per-party mode that lists a tokens Receiver.
  await db.query(
    `insert into public.emsp_ocpi_peers
       (id, label, direction, status, token_ciphertext, registered_at, endpoints, roles, hub_push_mode)
     values ($1, 'Hub', 'outbound', 'registered', 'v1:x', now(), $2, $3, 'per_party')`,
    [
      HUB,
      JSON.stringify([
        {
          identifier: "tokens",
          role: "RECEIVER",
          url: "https://hub.example.test/ocpi/2.2.1/tokens",
        },
      ]),
      JSON.stringify([
        {
          role: "HUB",
          country_code: "ZZ",
          party_id: "HUB",
          business_details: { name: "Hub" },
        },
      ]),
    ],
  );
});

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
});
