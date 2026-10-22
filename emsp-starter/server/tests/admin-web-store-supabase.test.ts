import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  cdrForSession,
  sampleCdrToken,
  sampleLocations,
  sampleSessions,
} from "@/lib/mock-cpo/sample-data";
import { SupabasePeerStore } from "@/lib/ocpi/store-supabase";
import {
  MemoryPaymentStore,
  type PaymentReconciliationRow,
  type PaymentStore,
} from "@/lib/payments/store";
import { SupabasePaymentStore } from "@/lib/payments/store-supabase";
import { MemorySessionStore, type SessionStore } from "@/lib/sessions/store";
import { SupabaseSessionStore } from "@/lib/sessions/store-supabase";
import { asRole, migratedDatabase } from "./support/pglite";
import { pgliteRest } from "./support/pglite-rest";

const A = "8b0f0b5e-3c47-4c1e-9d55-4f1f0f8d2b11";
const B = "0c5c1f0e-77a2-4f7e-8f2c-5d0a3e9b6c22";
const NOW = "2026-10-01T06:00:00.000Z";
const CPO = { countryCode: "ZZ", partyId: "MCK" };
const EMSP = { countryCode: "NL", partyId: "DMO" };
const URL_ = "https://db.example.test";
const KEY = "test-service-role-key";

let db: PGlite;
let sessions: SupabaseSessionStore;
let payments: SupabasePaymentStore;
let peers: SupabasePeerStore;
const memSessions = new MemorySessionStore();
const memPayments = new MemoryPaymentStore(() => memSessions.cdrs.values());
const commands: string[] = [];

/** A START_SESSION command row, as the commands module makes it. */
async function command(driverRef: string): Promise<string> {
  const {
    rows: [row],
  } = await db.query<{ id: string }>(
    `insert into public.emsp_commands (type, driver_ref, request_id, peer_id, to_country_code,
       to_party_id, location_id, authorization_reference, deadline_at)
     values ('START_SESSION', $4, $1, $2, 'ZZ', 'MCK', 'LOC1', $3, now()) returning id`,
    [`req-${crypto.randomUUID()}`, A, crypto.randomUUID(), driverRef],
  );
  return row.id;
}

/**
 * The same ledger in a session and a payment store: at peer A, CDR-0 paid in full,
 * CDR-1 under-captured and partly refunded, CDR-2 paid in another currency, CDR-3 of
 * our driver with no payment, CDR-4 of a token we did not issue, and a credit CDR; one
 * session still active; at peer B, one session.
 */
async function fill(s: SessionStore, p: PaymentStore) {
  const locations = sampleLocations(CPO, 3);
  const [s1, s2, s3] = sampleSessions(CPO, EMSP);
  const base = [s1, s2, s1, s2, s1];
  for (const [i, src] of base.entries()) {
    const session = { ...src, id: `P${i}` };
    const commandId = i < 3 ? commands[i] : null;
    const driverRef = i === 4 ? null : "driver-1";
    await s.insertSession(
      A,
      { session, fieldTimes: {}, driverRef, commandId, completedAt: NOW },
      NOW,
    );
    const cdr = (await s.insertCdr(
      A,
      {
        cdr: cdrForSession(
          session,
          locations.find((l) => l.id === session.location_id)!,
          { id: `CDR-${i}`, cdr_token: sampleCdrToken(EMSP) },
        ),
        driverRef,
        commandId,
        source: "push",
      },
      NOW,
    ))!;
    if (!commandId) continue;
    const payment = (await p.insert(
      {
        commandId,
        driverRef: "driver-1",
        currency: i === 2 ? "GBP" : "EUR",
        holdAmount: 2500,
        paymentMethodId: null,
      },
      NOW,
    ))!;
    await p.transition(
      payment.id,
      ["pending"],
      {
        status: "captured",
        authorizedAmount: 2500,
        capturedAmount: i === 1 ? 2000 : 1500,
        cdrId: cdr.id,
        cdrCurrency: "EUR",
        cdrAmount: i === 1 ? 2321 : 1500,
      },
      NOW,
    );
    if (i === 1) {
      const r = await p.reserveRefund({
        paymentId: payment.id,
        requestId: "refund-0001",
        amount: 300,
        reason: "Test refund",
        actor: "admin:secret",
      });
      await p.settleRefund(r.refund!.id, "succeeded", null);
    }
  }
  const credit = cdrForSession(
    { ...s1, id: "P0" },
    locations.find((l) => l.id === s1.location_id)!,
    { id: "CDR-C", credit: true, credit_reference_id: "CDR-0" },
  );
  await s.insertCdr(
    A,
    { cdr: credit, driverRef: "driver-1", commandId: null, source: "push" },
    NOW,
  );
  await s.insertSession(
    A,
    {
      session: s3,
      fieldTimes: {},
      driverRef: "driver-2",
      commandId: null,
      completedAt: null,
    },
    NOW,
  );
  await s.insertSession(
    B,
    {
      session: { ...s1, id: "B1" },
      fieldTimes: {},
      driverRef: "driver-1",
      commandId: null,
      completedAt: NOW,
    },
    NOW,
  );
}

beforeAll(async () => {
  db = await migratedDatabase();
  const rest = pgliteRest(db);
  sessions = new SupabaseSessionStore(URL_, KEY, rest);
  payments = new SupabasePaymentStore(URL_, KEY, rest);
  peers = new SupabasePeerStore(URL_, KEY, rest);
  for (const id of [A, B])
    await db.query(
      "insert into public.emsp_ocpi_peers (id, label, direction) values ($1, 'CPO', 'outbound')",
      [id],
    );
  // One open start per driver: each command is another driver's.
  for (let i = 0; i < 3; i++) commands.push(await command(`driver-c${i}`));
  await fill(sessions, payments);
  await fill(memSessions, memPayments);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

/** Payment IDs differ between the stores: name each by its command. */
async function byCommand(rows: PaymentReconciliationRow[], p: PaymentStore) {
  return Promise.all(
    rows.map(async (r) => ({
      ...r,
      amountMismatchIds: await Promise.all(
        r.amountMismatchIds.map(async (id) => (await p.get(id))!.commandId),
      ),
    })),
  );
}

describe("emsp_payment_reconciliation", () => {
  const q = { from: "2026-09-29T00:00:00Z", to: "2026-10-03T00:00:00Z" };

  it(
    "sums captures and refunds per peer and day, and lists unpaid CDRs and mismatches",
    { timeout: 20_000 },
    async () => {
      const rows = await payments.reconcileCdrs(q);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        peerId: A,
        currency: "EUR",
        cdrsPaid: 3,
        cdrsUnpaid: 1,
        cdrsUnpaidIds: ["ZZ/MCK/CDR-3"],
        // CDR-2's GBP payment is not summed.
        capturedAmount: 3500,
        refundedAmount: 300,
        cdrAmount: 1500 + 2321 + 1500,
        amountMismatches: 2,
      });
      expect(
        (await byCommand(rows, payments))[0].amountMismatchIds.sort(),
      ).toEqual([commands[1], commands[2]].sort());
      expect(await payments.reconcileCdrs({ ...q, peerId: B })).toEqual([]);
    },
  );

  it(
    "gives the same figures as the memory store",
    { timeout: 20_000 },
    async () => {
      for (const query of [q, { ...q, peerId: A }, { ...q, peerId: B }])
        expect(
          await byCommand(await payments.reconcileCdrs(query), payments),
        ).toEqual(
          await byCommand(await memPayments.reconcileCdrs(query), memPayments),
        );
    },
  );

  it("is for the service role only", { timeout: 20_000 }, async () => {
    for (const role of ["anon", "authenticated"] as const)
      await expect(
        asRole(db, role, () =>
          db.query(
            "select * from public.emsp_payment_reconciliation(now() - interval '1 day', now(), null)",
          ),
        ),
      ).rejects.toThrow(/permission denied/);
  });
});

describe("session list", () => {
  it(
    "filters by peer, status and driver, newest start first, like the memory store",
    { timeout: 20_000 },
    async () => {
      const ids = (list: { session: { id: string } }[]) =>
        list.map((s) => s.session.id);
      for (const query of [
        { limit: 100 },
        { limit: 1 },
        { statuses: ["ACTIVE", "PENDING", "RESERVATION"], limit: 100 },
        { statuses: ["COMPLETED"], peerId: A, limit: 100 },
        { peerId: B, limit: 100 },
        { driverRef: "driver-2", limit: 100 },
        { before: "2026-09-30T22:00:00Z", limit: 100 },
      ]) {
        const live = await sessions.listSessions(query);
        // Ties on the start are ordered by our row ID, which differs per store.
        expect(ids(live).sort()).toEqual(
          ids(await memSessions.listSessions(query)).sort(),
        );
        const starts = live.map((s) => Date.parse(s.session.start_date_time));
        expect([...starts].sort((a, b) => b - a)).toEqual(starts);
      }
      expect(
        ids(await sessions.listSessions({ statuses: ["ACTIVE"], limit: 10 })),
      ).toEqual(["S3"]);
      expect(
        ids(await sessions.listSessions({ peerId: B, limit: 10 })),
      ).toEqual(["B1"]);
    },
  );
});

describe("audit log read", () => {
  it(
    "reads one subject's entries, newest first",
    { timeout: 20_000 },
    async () => {
      // The REST test double only emulates idempotent inserts: write the rows in SQL.
      for (const [i, action] of ["a.one", "a.two", "a.three"].entries())
        await db.query(
          `insert into public.emsp_audit_log (occurred_at, actor, action, subject_type, subject_id, details)
           values ($1, 'admin:secret', $2, 'ocpi_peer', 'subject-1', $3)`,
          [`2026-10-01T0${i}:00:00Z`, action, JSON.stringify({ n: action })],
        );
      await db.query(
        `insert into public.emsp_audit_log (actor, action, subject_id) values ('system', 'b', 'other')`,
      );
      const entries = await peers.listAudit("subject-1", 2);
      expect(entries.map((e) => e.action)).toEqual(["a.three", "a.two"]);
      expect(entries[0]).toMatchObject({
        actor: "admin:secret",
        subjectId: "subject-1",
        details: { n: "a.three" },
      });
      expect(Date.parse(entries[0].at)).not.toBeNaN();
    },
  );
});
