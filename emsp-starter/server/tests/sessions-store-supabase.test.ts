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
import { SupabaseCommandStore } from "@/lib/commands/store-supabase";
import {
  cdrForSession,
  sampleCdrToken,
  sampleLocations,
} from "@/lib/mock-cpo/sample-data";
import type { Cdr, Session } from "@/lib/ocpi/session-objects";
import { MemoryPeerStore, type Peer } from "@/lib/ocpi/store";
import { onSessionEvent, type SessionEvent } from "@/lib/sessions/events";
import {
  patchSession,
  recordCdr,
  recordSession,
  type SessionDeps,
} from "@/lib/sessions/record";
import { reconcile } from "@/lib/sessions/reconcile";
import { MemorySessionStore, type SessionStore } from "@/lib/sessions/store";
import { SupabaseSessionStore } from "@/lib/sessions/store-supabase";
import { MemoryTokenStore, type TokenStore } from "@/lib/tokens/store";
import { asRole, migratedDatabase } from "./support/pglite";
import { pgliteRest } from "./support/pglite-rest";
import { LIVE_ENV } from "./support/network";

const A = "8b0f0b5e-3c47-4c1e-9d55-4f1f0f8d2b11";
const B = "0c5c1f0e-77a2-4f7e-8f2c-5d0a3e9b6c22";
const saved = { ...process.env };
let db: PGlite;
let store: SupabaseSessionStore;
let commands: SupabaseCommandStore;

const peer = (id: string, countryCode: string, partyId: string): Peer => ({
  id,
  label: id === A ? "CPO A" : "CPO B",
  direction: "outbound",
  status: "registered",
  versionsUrl: null,
  version: "2.2.1",
  roles: [
    {
      role: "CPO",
      business_details: { name: "CPO" },
      country_code: countryCode,
      party_id: partyId,
    },
  ],
  endpoints: [],
  tokenCiphertext: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  registeredAt: "2026-10-01T00:00:00.000Z",
  unregisteredAt: null,
});
const peerA = peer(A, "ZZ", "MCK");
const peerB = peer(B, "YY", "TWO");

beforeAll(async () => {
  db = await migratedDatabase();
  const rest = pgliteRest(db);
  store = new SupabaseSessionStore(
    "https://db.example.test",
    "test-service-role-key",
    rest,
  );
  commands = new SupabaseCommandStore(
    "https://db.example.test",
    "test-service-role-key",
    rest,
  );
}, 60_000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  Object.assign(process.env, LIVE_ENV);
  // CDRs refuse deletes: drop the trigger's table contents the only way left.
  await db.exec(`
    alter table public.emsp_cdrs disable trigger emsp_cdrs_immutable;
    delete from public.emsp_cdrs;
    alter table public.emsp_cdrs enable trigger emsp_cdrs_immutable;
    delete from public.emsp_sessions;
    delete from public.emsp_commands;
    delete from public.emsp_ocpi_sync_state;
    delete from public.emsp_ocpi_peers;
  `);
  for (const id of [A, B])
    await db.query(
      "insert into public.emsp_ocpi_peers (id, label, direction) values ($1, 'CPO', 'outbound')",
      [id],
    );
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const deps = (sessions: SessionStore): SessionDeps => ({
  sessions,
  commands,
  tokens: new MemoryTokenStore(),
  peers: new MemoryPeerStore(),
});

const T = (day: string, time = "10:00:00") => `${day}T${time}Z`;

const session = (
  party: { countryCode: string; partyId: string },
  id: string,
  over: Partial<Session> = {},
): Session => ({
  country_code: party.countryCode,
  party_id: party.partyId,
  id,
  start_date_time: T("2026-10-20"),
  kwh: 10,
  cdr_token: sampleCdrToken({ countryCode: "NL", partyId: "ABC" }),
  auth_method: "WHITELIST",
  location_id: "LOC1",
  evse_uid: "LOC1-1",
  connector_id: "1",
  currency: "EUR",
  status: "COMPLETED",
  last_updated: T("2026-10-20", "11:00:00"),
  ...over,
});

const [location] = sampleLocations({ countryCode: "ZZ", partyId: "MCK" }, 1);
const cdr = (s: Session, over: Partial<Cdr> = {}): Cdr => ({
  ...cdrForSession(s, location),
  ...over,
});

describe("Supabase session store on PGlite", () => {
  it("stores, patches and links sessions, with compare-and-swap writes", async () => {
    const d = deps(store);
    const s = session({ countryCode: "ZZ", partyId: "MCK" }, "S1", {
      status: "ACTIVE",
      kwh: 0,
    });
    const created = await recordSession(peerA, s, d);
    expect(created.outcome).toBe("created");
    expect(created.session).toMatchObject({
      peerId: A,
      session: s,
      completedAt: null,
      fieldTimes: { kwh: s.last_updated, status: s.last_updated },
    });
    // Many PATCHes at once, each with one period: every one lands.
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        patchSession(
          peerA,
          { peerId: A, countryCode: "ZZ", partyId: "MCK", sessionId: "S1" },
          {
            kwh: i + 1,
            charging_periods: [
              {
                start_date_time: T("2026-10-20", `10:0${i}:00`),
                dimensions: [{ type: "ENERGY", volume: 1 }],
              },
            ],
            last_updated: T("2026-10-20", `11:0${i + 1}:00`),
          },
          d,
        ),
      ),
    );
    const held = (await store.getSession({
      peerId: A,
      countryCode: "zz",
      partyId: "mck",
      sessionId: "S1",
    }))!;
    expect(held.session.charging_periods).toHaveLength(6);
    // The newest kWh, whatever order the PATCHes landed in.
    expect(held.session.kwh).toBe(6);
    expect(held.session.last_updated).toBe(T("2026-10-20", "11:06:00"));
    expect(await store.findSessions(A, "S1")).toHaveLength(1);
    expect((await store.getSessionById(held.id))!.revision).toBe(held.revision);
    // A stale revision never writes.
    expect(
      await store.updateSession(
        held.id,
        crypto.randomUUID(),
        held,
        T("2026-10-21"),
      ),
    ).toBeNull();
  });

  it("links a session to the start it came from, once", async () => {
    const { command } = await commands.claim({
      type: "START_SESSION",
      driverRef: "driver-1",
      requestId: "req-000001",
      peerId: A,
      toCountryCode: "ZZ",
      toPartyId: "MCK",
      locationId: "LOC1",
      evseUid: null,
      connectorId: null,
      sessionId: null,
      authorizationReference: "ref-1",
      deadlineAt: T("2026-10-20"),
    });
    const d = deps(store);
    const party = { countryCode: "ZZ", partyId: "MCK" };
    await recordSession(
      peerA,
      session(party, "S1", { authorization_reference: "ref-1" }),
      d,
    );
    await recordSession(
      peerA,
      session(party, "S2", { authorization_reference: "ref-1" }),
      d,
    );
    expect(await store.findSessions(A, "S1")).toMatchObject([
      { driverRef: "driver-1", commandId: command.id },
    ]);
    // The start belongs to S1: S2 is not linked to it.
    expect(await store.findSessions(A, "S2")).toMatchObject([
      { commandId: null },
    ]);
    expect((await commands.get(command.id))!.sessionId).toBe("S1");
  });

  it("stores a CDR once and never changes it, even as the table owner", async () => {
    const d = deps(store);
    const s = session({ countryCode: "ZZ", partyId: "MCK" }, "S1");
    const c = cdr(s, { total_cost: { excl_vat: 1.2345, incl_vat: 1.4937 } });
    const first = await recordCdr(peerA, c, "push", d);
    expect(first.outcome).toBe("created");
    expect(first.cdr).toMatchObject({ peerId: A, cdr: c, source: "push" });
    expect((await recordCdr(peerA, c, "pull", d)).outcome).toBe("duplicate");
    expect(
      (await recordCdr(peerA, { ...c, total_energy: 1 }, "push", d)).outcome,
    ).toBe("conflict");
    expect((await store.getCdrById(first.cdr.id))!.cdr).toEqual(c);
    expect(
      await store.hasCdr({
        peerId: A,
        countryCode: "ZZ",
        partyId: "MCK",
        sessionId: "S1",
      }),
    ).toBe(true);
    const [row] = (
      await db.query<{ total_cost_excl_vat_e4: unknown }>(
        "select total_cost_excl_vat_e4 from public.emsp_cdrs",
      )
    ).rows;
    expect(Number(row.total_cost_excl_vat_e4)).toBe(12345);
    await asRole(db, "service_role", async () => {
      await expect(
        db.query("update public.emsp_cdrs set source = 'pull'"),
      ).rejects.toThrow(/permission denied/);
      await expect(db.query("delete from public.emsp_cdrs")).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        db.query("delete from public.emsp_sessions"),
      ).rejects.toThrow(/permission denied/);
    });
    await expect(
      db.query("update public.emsp_cdrs set source = 'pull'"),
    ).rejects.toThrow(/immutable/);
    await expect(db.query("delete from public.emsp_cdrs")).rejects.toThrow(
      /immutable/,
    );
  });

  it("keeps sessions and CDRs away from anon and authenticated", async () => {
    for (const role of ["anon", "authenticated"] as const)
      await asRole(db, role, async () => {
        for (const sql of [
          "select * from public.emsp_sessions",
          "select * from public.emsp_cdrs",
          "select * from public.emsp_reconciliation(now(), now(), null)",
        ])
          await expect(db.query(sql)).rejects.toThrow(/permission denied/);
      });
  });

  it("rejects malformed rows", async () => {
    const bad = [
      `insert into public.emsp_sessions (peer_id, country_code, party_id, session_id, data,
         status, start_date_time, kwh_e4, currency, last_updated)
       values ('${A}', 'ZZ', 'MCK', 'S', '{}', 'CHARGING', now(), 0, 'EUR', now())`,
      `insert into public.emsp_sessions (peer_id, country_code, party_id, session_id, data,
         status, start_date_time, kwh_e4, currency, last_updated)
       values ('${A}', 'ZZ', 'MCK', 'S', '{}', 'ACTIVE', now(), -1, 'EUR', now())`,
      `insert into public.emsp_cdrs (peer_id, country_code, party_id, cdr_id, data,
         start_date_time, end_date_time, currency, total_energy_e4,
         total_cost_excl_vat_e4, credit, last_updated, source)
       values ('${A}', 'ZZ', 'MCK', 'C', '{}', now(), now(), 'EUR', 0, 0, true, now(), 'push')`,
      `insert into public.emsp_cdrs (peer_id, country_code, party_id, cdr_id, data,
         start_date_time, end_date_time, currency, total_energy_e4,
         total_cost_excl_vat_e4, last_updated, source)
       values ('${A}', 'ZZ', 'MCK', 'C', '{}', now(), now(), 'EUR', 0, 0, now(), 'mail')`,
    ];
    for (const sql of bad)
      await expect(db.query(sql)).rejects.toThrow(/check constraint/);
  });
});

describe("reconciliation", () => {
  /**
   * Two peers, two days and every case: a session with its CDR, one without, open and
   * invalid sessions, a CDR naming an unknown session, one naming none (and without
   * an amount including VAT), a credit CDR, a CDR of a token we did not issue, a CDR
   * in another currency than its session, the same IDs at the other peer, and a
   * session outside the range.
   */
  async function scenario(sessions: SessionStore) {
    // Our drivers' token is the sample one; any other is not ours.
    const ours = sampleCdrToken({ countryCode: "NL", partyId: "ABC" });
    const d: SessionDeps = {
      ...deps(sessions),
      tokens: {
        getToken: async (uid: string) =>
          uid === ours.uid ? { driverRef: "driver-1" } : null,
      } as unknown as TokenStore,
    };
    const zz = { countryCode: "ZZ", partyId: "MCK" };
    const yy = { countryCode: "YY", partyId: "TWO" };
    const day1 = "2026-10-20";
    const s1 = session(zz, "S1", { kwh: 10.5 });
    await recordSession(peerA, s1, d);
    await recordCdr(
      peerA,
      cdr(s1, {
        id: "C1",
        total_energy: 10.5,
        total_cost: { excl_vat: 5.1234, incl_vat: 6.2 },
      }),
      "push",
      d,
    );
    await recordSession(peerA, session(zz, "S2", { kwh: 3 }), d);
    await recordSession(
      peerA,
      session(zz, "S3", { kwh: 1, status: "ACTIVE" }),
      d,
    );
    await recordSession(
      peerA,
      session(zz, "S4", { kwh: 2, status: "INVALID" }),
      d,
    );
    await recordCdr(
      peerA,
      cdr(s1, {
        id: "C9",
        session_id: "NOPE",
        cdr_token: sampleCdrToken({ countryCode: "NL", partyId: "ABC" }, 2),
        total_energy: 1,
        total_cost: { excl_vat: 1, incl_vat: 1.21 },
      }),
      "pull",
      d,
    );
    const c10 = cdr(s1, {
      id: "C10",
      total_energy: 2,
      total_cost: { excl_vat: 2 },
    });
    delete c10.session_id;
    await recordCdr(peerA, c10, "pull", d);
    await recordCdr(
      peerA,
      cdr(s1, {
        id: "CR1",
        credit: true,
        credit_reference_id: "C1",
        total_energy: 10.5,
        total_cost: { excl_vat: -5.1234, incl_vat: -6.2 },
      }),
      "push",
      d,
    );
    // Billed in dollars, for a session in euros.
    const s7 = session(zz, "S7", { kwh: 0 });
    await recordSession(peerA, s7, d);
    await recordCdr(
      peerA,
      cdr(s7, { id: "C7", currency: "USD", total_energy: 0 }),
      "push",
      d,
    );
    // Day two, at both peers with the same IDs, the last second of the day.
    const late = {
      start_date_time: T("2026-10-21", "23:59:59"),
      end_date_time: T("2026-10-22", "00:30:00"),
      last_updated: T("2026-10-22", "00:31:00"),
    };
    const a5 = session(zz, "S5", late);
    await recordSession(peerA, a5, d);
    await recordCdr(peerA, cdr(a5, { id: "C5" }), "push", d);
    const b1 = session(yy, "S1", { ...late, kwh: 7 });
    await recordSession(peerB, b1, d);
    await recordCdr(peerB, cdr(b1, { id: "C1" }), "push", d);
    // Outside the range.
    await recordSession(
      peerA,
      session(zz, "S6", { start_date_time: T("2026-10-22", "00:00:00") }),
      d,
    );
    return day1;
  }

  it("gives per peer and day the gaps and the totals, the same in Postgres and in memory", async () => {
    const memory = new MemorySessionStore();
    await scenario(memory);
    await scenario(store);
    const range = { from: "2026-10-20", to: "2026-10-21" };
    const fromMemory = await reconcile(range, { sessions: memory });
    const fromDb = await reconcile(range, { sessions: store });
    expect(fromDb).toEqual(fromMemory);

    const days = fromDb.days;
    expect(days.map((r) => [r.peerId, r.day, r.currency])).toEqual([
      [B, "2026-10-21", "EUR"],
      [A, "2026-10-20", "EUR"],
      [A, "2026-10-20", "USD"],
      [A, "2026-10-21", "EUR"],
    ]);
    expect(days[1]).toEqual({
      peerId: A,
      day: "2026-10-20",
      currency: "EUR",
      sessions: 5,
      sessionsOpen: 1,
      sessionsCompleted: 3,
      sessionsInvalid: 1,
      sessionKwhE4: 145_000,
      sessionsWithoutCdr: 1,
      sessionsWithoutCdrIds: ["ZZ/MCK/S2"],
      cdrs: 3,
      creditCdrs: 1,
      cdrsWithoutSession: 2,
      cdrsWithoutSessionIds: ["ZZ/MCK/C10", "ZZ/MCK/C9"],
      cdrsUnknownToken: 1,
      cdrsUnknownTokenIds: ["ZZ/MCK/C9"],
      cdrsCurrencyMismatch: 0,
      cdrsCurrencyMismatchIds: [],
      // C1 + C9 + C10 - CR1.
      cdrEnergyE4: 30_000,
      cdrCostExclVatE4: 30_000,
      // C10 gave no amount including VAT.
      cdrCostInclVatE4: null,
    });
    // C7 counts in its own currency, flagged against its session's.
    expect(days[2]).toMatchObject({
      sessions: 0,
      cdrs: 1,
      cdrsWithoutSession: 0,
      cdrsUnknownToken: 0,
      cdrsCurrencyMismatch: 1,
      cdrsCurrencyMismatchIds: ["ZZ/MCK/C7"],
    });
    expect(days[0]).toMatchObject({
      sessions: 1,
      sessionsWithoutCdr: 0,
      cdrs: 1,
      cdrsWithoutSession: 0,
      cdrEnergyE4: 70_000,
    });
    expect(fromDb.totals).toEqual([
      expect.objectContaining({ peerId: B, sessions: 1, cdrs: 1 }),
      expect.objectContaining({
        peerId: A,
        currency: "EUR",
        sessions: 6,
        sessionsWithoutCdr: 1,
        cdrs: 4,
        cdrsWithoutSession: 2,
        cdrsUnknownToken: 1,
        cdrCostInclVatE4: null,
      }),
      expect.objectContaining({
        peerId: A,
        currency: "USD",
        cdrs: 1,
        cdrsCurrencyMismatch: 1,
      }),
    ]);
    // One peer only.
    expect(
      (await reconcile({ ...range, peerId: B }, { sessions: store })).days,
    ).toHaveLength(1);
  });

  it("refuses ranges it cannot answer", async () => {
    for (const range of [
      { from: "2026-10-21", to: "2026-10-20" },
      { from: "2026-02-30", to: "2026-03-01" },
      { from: "yesterday", to: "2026-10-20" },
      { from: "2026-01-01", to: "2026-12-31" },
    ])
      await expect(
        reconcile(range, { sessions: new MemorySessionStore() }),
      ).rejects.toThrow();
  });
});

describe("events on PGlite", () => {
  it("emits started and completed once, even when the same session arrives twice at once", async () => {
    const events: SessionEvent[] = [];
    const off = onSessionEvent((e) => {
      events.push(e);
    });
    try {
      const s = session({ countryCode: "ZZ", partyId: "MCK" }, "S1");
      const outcomes = await Promise.all([
        recordSession(peerA, s, deps(store)),
        recordSession(peerA, s, deps(store)),
      ]);
      expect(outcomes.map((o) => o.outcome).sort()).toEqual([
        "created",
        "unchanged",
      ]);
      expect(events.map((e) => e.type)).toEqual([
        "session.started",
        "session.completed",
      ]);
    } finally {
      off();
    }
  });
});
