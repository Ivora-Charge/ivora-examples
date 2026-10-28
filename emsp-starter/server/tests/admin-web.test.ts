import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Server actions read the request's cookies (the admin session); tests set them here.
const requestCookies = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      requestCookies.has(name)
        ? { name, value: requestCookies.get(name) }
        : undefined,
  }),
  headers: async () => new Headers(),
}));

import { listPeersAction, syncPeerAction } from "@/app/admin/peers/actions";
import { paymentAuditAction, refundAction } from "@/app/admin/payments/actions";
import { requestIdSpent } from "@/app/admin/payments/request-id";
import { reconcileAction } from "@/app/admin/reconciliation/actions";
import { listSessionsAction } from "@/app/admin/sessions/actions";
import { driverAccountAction } from "@/app/admin/tokens/actions";
import { ADMIN_COOKIE } from "@/lib/accounts/admin-session";
import type { AuthProvider } from "@/lib/accounts/auth";
import {
  setAccountStoreForTests,
  setAuthProviderForTests,
} from "@/lib/accounts/registry";
import { MemoryAccountStore } from "@/lib/accounts/store";
import { explain, explainMessage, OCPI_NEXT_STEP } from "@/lib/admin/errors";
import {
  csvCell,
  e4ToDecimal,
  minorToDecimal,
  reconcileWithPayments,
  reconciliationCsv,
} from "@/lib/admin/reconciliation";
import {
  DEMO_PEER_ID,
  setLocationStoreForTests,
} from "@/lib/locations/registry";
import { MemoryLocationStore } from "@/lib/locations/store";
import { SyncError } from "@/lib/locations/sync";
import {
  cdrForSession,
  sampleCdrToken,
  sampleLocations,
  sampleSessions,
} from "@/lib/mock-cpo/sample-data";
import {
  OcpiClientError,
  OcpiNotSentError,
  OcpiTransportError,
  OcpiUnauthorizedError,
} from "@/lib/ocpi/errors";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { MemoryPeerStore } from "@/lib/ocpi/store";
import {
  setPaymentStoreForTests,
  setStripeForTests,
} from "@/lib/payments/registry";
import { PaymentError } from "@/lib/payments/settle";
import { MemoryPaymentStore, type Payment } from "@/lib/payments/store";
import { StripeUnknownError, type StripeApi } from "@/lib/payments/stripe";
import { resetAdminLimitForTests } from "@/lib/server/admin";
import { DemoModeError } from "@/lib/server/demo";
import { setSessionStoreForTests } from "@/lib/sessions/registry";
import { MemorySessionStore } from "@/lib/sessions/store";
import { driverStanding } from "@/lib/tokens/authorize";
import { DEMO_DRIVER_REF } from "@/lib/tokens/registry";
import { LIVE_ENV } from "./support/network";

const SECRET = "s".repeat(32);
const PEER = "8b0f0b5e-3c47-4c1e-9d55-4f1f0f8d2b11";
const OTHER = "0c5c1f0e-77a2-4f7e-8f2c-5d0a3e9b6c22";
const saved = { ...process.env };
let peers: MemoryPeerStore;
let fetchSpy: ReturnType<typeof vi.fn>;

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ adminSecret: SECRET, ...fields }))
    f.set(k, v);
  return f;
};

beforeEach(() => {
  resetAdminLimitForTests();
  for (const k of Object.keys(LIVE_ENV)) delete process.env[k];
  process.env.DEMO_MODE = "true";
  process.env.ADMIN_SECRET = SECRET;
  peers = new MemoryPeerStore();
  setPeerStoreForTests(peers);
  fetchSpy = vi.fn(() => {
    throw new Error("no network in tests");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  setPeerStoreForTests(undefined);
  setLocationStoreForTests(undefined);
  setSessionStoreForTests(undefined);
  setPaymentStoreForTests(undefined);
  setAccountStoreForTests(undefined);
  setAuthProviderForTests(undefined);
  setStripeForTests(undefined);
  requestCookies.clear();
  vi.unstubAllGlobals();
  process.env = { ...saved };
  expect(fetchSpy).not.toHaveBeenCalled();
});

const request = { request: "GET cpo.example.com/ocpi/2.2.1/locations" };

describe("an OCPI error code and a next step on every error", () => {
  it("names the CPO's OCPI status code, with what to do", () => {
    expect(
      explain(
        new OcpiClientError("failed with OCPI status 2001", {
          ...request,
          statusCode: 2001,
          httpStatus: 400,
        }),
      ),
    ).toEqual({ code: "OCPI 2001", nextStep: OCPI_NEXT_STEP[2001] });
    // An unlisted code falls back to its class.
    expect(
      explain(new OcpiClientError("x", { ...request, statusCode: 3999 }))
        .nextStep,
    ).toBe(OCPI_NEXT_STEP[3000]);
    expect(
      explain(
        new OcpiUnauthorizedError("refused our token (HTTP 401)", {
          ...request,
          httpStatus: 401,
        }),
      ),
    ).toMatchObject({ code: "HTTP 401", nextStep: /Rotate tokens/ });
    expect(explain(new OcpiTransportError("timed out", request))).toMatchObject(
      { code: "no_ocpi_response" },
    );
    expect(explain(new OcpiNotSentError("refused: x", request))).toMatchObject({
      code: "not_sent",
    });
    expect(explain(new DemoModeError("pull"))).toMatchObject({
      code: "demo_mode",
    });
    expect(explain(new SyncError("Pulling failed", 3001, 200))).toMatchObject({
      code: "OCPI 3001",
    });
  });

  it("reads the code back from a message, for handshake errors and stored pulls", () => {
    expect(
      explainMessage(
        "Registration at the CPO failed: POST cpo.example.com/ocpi/2.2.1/credentials failed with OCPI status 3003 (HTTP 200): no endpoints",
      ),
    ).toEqual({ code: "OCPI 3003", nextStep: OCPI_NEXT_STEP[3003] });
    expect(explainMessage("No such peer.")).toMatchObject({
      code: "not_found",
    });
    expect(explainMessage("Peer ID must be a UUID.")).toMatchObject({
      code: "invalid_input",
    });
  });

  it("explains payment errors without card data", () => {
    expect(explain(new PaymentError("x", 502))).toMatchObject({
      code: "stripe_no_answer",
    });
    expect(
      explain(new PaymentError("That is more than what is left to refund.")),
    ).toMatchObject({ code: "above_captured" });
    expect(
      explain(new PaymentError("Stripe refused the refund (charge_disputed).")),
    ).toMatchObject({ code: "stripe_charge_disputed" });
  });

  it("puts one on every refusal of the admin gate and every failed action", async () => {
    for (const result of [
      await listSessionsAction({}, form({ adminSecret: "wrong" })),
      await listSessionsAction({}, form({ peerId: "not-a-uuid" })),
      await syncPeerAction({}, form({ peerId: PEER })),
      await reconcileAction({}, form({ from: "2026-13-01", to: "2026-10-01" })),
    ]) {
      expect(result.ok).toBe(false);
      expect(result.code).toMatch(/\S/);
      expect(result.nextStep).toMatch(/\S/);
    }
    delete process.env.ADMIN_SECRET;
    expect(await listSessionsAction({}, form({}))).toMatchObject({
      ok: false,
      code: "admin_disabled",
    });
  });
});

describe("CPO peers: status, last pull and errors per module", () => {
  it("shows each module's last pull, and a failed one with its OCPI code and next step", async () => {
    const locations = new MemoryLocationStore();
    setLocationStoreForTests(locations);
    const peer = await peers.createPeer({
      label: "CPO A",
      direction: "outbound",
    });
    await locations.saveSyncState(
      {
        peerId: peer.id,
        module: "locations",
        lastFullSyncAt: "2026-10-21T10:00:00.000Z",
        cursor: "2026-10-21T10:00:00.000Z",
        run: null,
        lastResult: {
          ok: true,
          mode: "full",
          finishedAt: "2026-10-21T10:00:05.000Z",
          items: 12,
          invalid: 1,
          removed: 0,
        },
      },
      null,
    );
    await locations.saveSyncState(
      {
        peerId: peer.id,
        module: "cdrs",
        lastFullSyncAt: null,
        cursor: null,
        run: null,
        lastResult: {
          ok: false,
          mode: "full",
          finishedAt: "2026-10-21T11:00:00.000Z",
          items: 0,
          invalid: 0,
          removed: 0,
          error:
            "GET cpo.example.com/ocpi/2.2.1/cdrs failed with OCPI status 2001 (HTTP 400)",
          statusCode: 2001,
          httpStatus: 400,
        },
      },
      null,
    );
    // A result stored before the code was kept: read from its message.
    await locations.saveSyncState(
      {
        peerId: peer.id,
        module: "sessions",
        lastFullSyncAt: null,
        cursor: null,
        run: null,
        lastResult: {
          ok: false,
          mode: "full",
          finishedAt: "2026-10-21T11:00:00.000Z",
          items: 0,
          invalid: 0,
          removed: 0,
          error:
            "GET cpo.example.com/ocpi/2.2.1/sessions failed with HTTP 503 and OCPI status 3000",
        },
      },
      null,
    );
    const listed = await listPeersAction({}, form({}));
    expect(listed.message).toMatch(/1 with a failed pull/);
    const mine = listed.peers!.find((p) => p.id === peer.id)!;
    const by = Object.fromEntries(mine.sync!.map((m) => [m.module, m]));
    expect(by.locations).toMatchObject({
      ok: true,
      items: 12,
      invalid: 1,
      lastPullAt: "2026-10-21T10:00:05.000Z",
      lastFullSyncAt: "2026-10-21T10:00:00.000Z",
    });
    expect(by.locations.code).toBeUndefined();
    expect(by.tariffs).toMatchObject({ ok: null, lastPullAt: null });
    expect(by.cdrs).toMatchObject({
      ok: false,
      code: "OCPI 2001",
      nextStep: OCPI_NEXT_STEP[2001],
    });
    expect(by.sessions).toMatchObject({ ok: false, code: "OCPI 3000" });
    // Demo mode lists the built-in mock CPO first.
    expect(listed.peers![0]).toMatchObject({ id: DEMO_PEER_ID, demo: true });
  });
});

describe("sessions: live and recent, by peer, status and driver", () => {
  function store() {
    const s = new MemorySessionStore();
    const cpo = { countryCode: "ZZ", partyId: "MCK" };
    const emsp = { countryCode: "NL", partyId: "DMO" };
    sampleSessions(cpo, emsp).forEach((session, i) =>
      s.insertSession(
        i === 0 ? OTHER : PEER,
        {
          session,
          fieldTimes: {},
          driverRef: i === 1 ? "driver-1" : null,
          commandId: null,
          completedAt: null,
        },
        "2026-10-01T00:00:00.000Z",
      ),
    );
    setSessionStoreForTests(s);
    return s;
  }

  it("shows a session's cost in its own currency, CAD with CA$ and JPY without decimals", async () => {
    const s = new MemorySessionStore();
    const cpo = { countryCode: "ZZ", partyId: "MCK" };
    const emsp = { countryCode: "NL", partyId: "DMO" };
    const [base] = sampleSessions(cpo, emsp);
    for (const [id, currency, total] of [
      ["cad", "CAD", { excl_vat: 19.18, incl_vat: 23.21 }],
      ["jpy", "JPY", { excl_vat: 1350 }],
    ] as const)
      s.insertSession(
        PEER,
        {
          session: {
            ...base,
            id,
            currency,
            total_cost: total,
            status: "COMPLETED",
          },
          fieldTimes: {},
          driverRef: null,
          commandId: null,
          completedAt: null,
        },
        "2026-10-01T00:00:00.000Z",
      );
    setSessionStoreForTests(s);
    const all = await listSessionsAction({}, form({ status: "all" }));
    const cost = (ref: string) =>
      all.sessions!.find((r) => r.ref.endsWith(`/${ref}`))!.cost;
    expect(cost("cad")).toBe("CA$19.18 excl. VAT, CA$23.21 incl.");
    expect(cost("jpy")).toBe("¥1,350 excl. VAT");
  });

  it("lists live sessions by default, and filters by status, peer and driver", async () => {
    store();
    const live = await listSessionsAction({}, form({}));
    expect(live.sessions!.map((s) => s.status)).toEqual(["ACTIVE"]);
    const all = await listSessionsAction({}, form({ status: "all" }));
    expect(all.sessions).toHaveLength(3);
    // Newest start first.
    const starts = all.sessions!.map((s) => Date.parse(s.start));
    expect([...starts].sort((a, b) => b - a)).toEqual(starts);
    expect(
      (await listSessionsAction({}, form({ status: "COMPLETED" }))).sessions,
    ).toHaveLength(2);
    expect(
      (await listSessionsAction({}, form({ status: "all", peerId: OTHER })))
        .sessions,
    ).toHaveLength(1);
    const driver = await listSessionsAction(
      {},
      form({ status: "all", driverRef: "driver-1" }),
    );
    expect(driver.sessions!.map((s) => s.driverRef)).toEqual(["driver-1"]);
    expect(
      (
        await listSessionsAction(
          {},
          form({ status: "all", before: "2026-09-01" }),
        )
      ).message,
    ).toBe("No sessions match.");
  });

  it("pages by start timestamp, never skipping sessions that started together", async () => {
    const s = new MemorySessionStore();
    const [template] = sampleSessions(
      { countryCode: "ZZ", partyId: "MCK" },
      { countryCode: "NL", partyId: "DMO" },
    );
    // 103 sessions, one a minute; the 100th and 101st newest start at the same time.
    const T = Date.parse("2026-10-01T00:00:00Z");
    for (let i = 0; i < 103; i++) {
      const minutes = i === 100 ? 99 : i;
      await s.insertSession(
        PEER,
        {
          session: {
            ...template,
            id: `S-${i}`,
            status: "COMPLETED",
            start_date_time: new Date(T - minutes * 60_000).toISOString(),
          },
          fieldTimes: {},
          driverRef: null,
          commandId: null,
          completedAt: null,
        },
        "2026-10-01T00:00:00.000Z",
      );
    }
    setSessionStoreForTests(s);

    const first = await listSessionsAction({}, form({ status: "all" }));
    expect(first.sessions).toHaveLength(100);
    expect(first.message).toContain("Show older sessions");
    expect(first.filters).toEqual({
      status: "all",
      peerId: "",
      driverRef: "",
      before: "",
    });
    expect(first.nextBefore).toBe("2026-09-30T22:21:00.001Z");

    const next = await listSessionsAction(
      {},
      form({ status: "all", older: first.nextBefore! }),
    );
    const seen = new Set(first.sessions!.map((r) => r.ref));
    const refs = next.sessions!.map((r) => r.ref);
    // The one that started with the oldest listed is on the next page, as is the rest.
    expect(new Set([...seen, ...refs]).size).toBe(103);
    expect(refs).toHaveLength(4);
    expect(next.nextBefore).toBeUndefined();
    expect(next.filters!.before).toBe(first.nextBefore);

    // A UTC timestamp or day is taken as "Started before"; anything else is refused.
    expect(
      (
        await listSessionsAction(
          {},
          form({ status: "all", before: "2026-09-30T23:00:00Z" }),
        )
      ).sessions,
    ).toHaveLength(42);
    expect(
      await listSessionsAction(
        {},
        form({ status: "all", before: "2026-09-30 10:00" }),
      ),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("refuses an unknown status or a malformed peer ID", async () => {
    store();
    expect(
      await listSessionsAction({}, form({ status: "DROP TABLE" })),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(
      await listSessionsAction({}, form({ peerId: "../x" })),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });
});

/** Sessions, CDRs and payments: one paid in full, one under-captured, one unpaid. */
async function ledger() {
  const sessions = new MemorySessionStore();
  const payments = new MemoryPaymentStore(() => sessions.cdrs.values());
  const cpo = { countryCode: "ZZ", partyId: "MCK" };
  const emsp = { countryCode: "NL", partyId: "DMO" };
  const now = "2026-10-01T06:00:00.000Z";
  const [s1, s2] = sampleSessions(cpo, emsp);
  const locations = sampleLocations(cpo, 3);
  const made: Payment[] = [];
  for (const [i, session] of [s1, s2].entries()) {
    const commandId = crypto.randomUUID();
    await sessions.insertSession(
      PEER,
      {
        session,
        fieldTimes: {},
        driverRef: "driver-1",
        commandId,
        completedAt: now,
      },
      now,
    );
    const cdr = await sessions.insertCdr(
      PEER,
      {
        cdr: cdrForSession(
          session,
          locations.find((l) => l.id === session.location_id)!,
          { id: `CDR-${i}`, cdr_token: sampleCdrToken(emsp) },
        ),
        driverRef: "driver-1",
        commandId,
        source: "push",
      },
      now,
    );
    if (i === 1) continue; // the second CDR has no payment
    const p = (await payments.insert(
      {
        commandId,
        driverRef: "driver-1",
        currency: "EUR",
        holdAmount: 2500,
        paymentMethodId: null,
      },
      now,
    ))!;
    made.push(
      (await payments.transition(
        p.id,
        ["pending"],
        {
          status: "captured",
          authorizedAmount: 2500,
          capturedAmount: 2000,
          cdrId: cdr!.id,
          cdrCurrency: "EUR",
          cdrAmount: 2321,
          review: "cdr_above_hold",
          shortfallAmount: 321,
        },
        now,
      ))!,
    );
  }
  return { sessions, payments, made };
}

describe("CDR reconciliation per peer", () => {
  it("compares sessions, CDRs and captured amounts, and lists the mismatches", async () => {
    const { sessions, payments, made } = await ledger();
    const report = await reconcileWithPayments(
      { from: "2026-09-29", to: "2026-10-02", peerId: PEER },
      { sessions, payments },
    );
    expect(report.totals).toHaveLength(1);
    const t = report.totals[0];
    expect(t).toMatchObject({
      peerId: PEER,
      currency: "EUR",
      sessions: 2,
      cdrs: 2,
      cdrsPaid: 1,
      cdrsUnpaid: 1,
      capturedAmount: 2000,
      cdrAmount: 2321,
      amountMismatches: 1,
    });
    expect(t.mismatches).toBe(2);
    const day = report.days.find((d) => d.cdrsUnpaid)!;
    expect(day.cdrsUnpaidIds).toEqual(["ZZ/MCK/CDR-1"]);
    expect(report.days.flatMap((d) => d.amountMismatchIds)).toEqual([
      made[0].id,
    ]);

    // Another peer's range has none of it.
    expect(
      (
        await reconcileWithPayments(
          { from: "2026-09-29", to: "2026-10-02", peerId: OTHER },
          { sessions, payments },
        )
      ).days,
    ).toEqual([]);

    const csv = reconciliationCsv(report, new Map([[PEER, "=CPO A"]]));
    const [head, ...rows] = csv.trimEnd().split("\r\n");
    expect(head.split(",")).toContain("amount_mismatch_payment_ids");
    expect(rows.join("\n")).toContain(made[0].id);
    // A label a spreadsheet would run as a formula is escaped.
    expect(rows[0]).toContain(",'=CPO A,");
    expect(rows.join("\n")).toContain(",20.00,"); // captured, in EUR
  });

  it("formats E4 and minor units exactly, and escapes CSV cells", () => {
    expect(e4ToDecimal(125000)).toBe("12.5");
    expect(e4ToDecimal(-5)).toBe("-0.0005");
    expect(e4ToDecimal(0)).toBe("0");
    expect(minorToDecimal(1235, "EUR")).toBe("12.35");
    expect(minorToDecimal(-5, "EUR")).toBe("-0.05");
    expect(minorToDecimal(1235, "JPY")).toBe("1235");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell(null)).toBe("");
  });

  it("runs from the admin web in demo mode, with a CSV and the flagged payments", async () => {
    const { sessions, payments } = await ledger();
    setSessionStoreForTests(sessions);
    setPaymentStoreForTests(payments);
    const r = await reconcileAction(
      {},
      form({ from: "2026-09-29", to: "2026-10-02" }),
    );
    expect(r).toMatchObject({ ok: true });
    expect(r.message).toMatch(/2 mismatch\(es\).*1 payment\(s\) flagged/);
    expect(r.flagged).toEqual([
      expect.objectContaining({
        review: "cdr_above_hold",
        captured: "20.00 EUR",
        shortfall: "3.21 EUR",
      }),
    ]);
    expect(r.totals![0].problems.map((p) => p.what)).toEqual([
      "CDRs of our drivers with no payment",
      "Payments whose capture is not the CDR total",
    ]);
    expect(r.csv).toMatch(/^peer_id,peer,day,currency,/);
    expect(r.filename).toBe("reconciliation_all_2026-09-29_2026-10-02.csv");
    expect(
      await reconcileAction({}, form({ from: "2026-01-01", to: "2026-10-01" })),
    ).toMatchObject({ ok: false, message: /At most 92 days/ });
  });
});

describe("refunds: partial or full, with a reason and an audit log", () => {
  async function captured() {
    const payments = new MemoryPaymentStore();
    setPaymentStoreForTests(payments);
    const p = (await payments.insert(
      {
        commandId: crypto.randomUUID(),
        driverRef: "driver-1",
        currency: "EUR",
        holdAmount: 2500,
        paymentMethodId: null,
      },
      "2026-10-01T06:00:00.000Z",
    ))!;
    await payments.transition(
      p.id,
      ["pending"],
      { status: "captured", authorizedAmount: 2500, capturedAmount: 1500 },
      "2026-10-01T07:00:00.000Z",
    );
    return { payments, p };
  }

  it("needs a reason", async () => {
    const { p } = await captured();
    expect(
      await refundAction(
        {},
        form({ paymentId: p.id, amount: "100", requestId: "refund-r-1" }),
      ),
    ).toMatchObject({
      ok: false,
      message: "Give a reason for the refund.",
      code: "invalid_input",
    });
  });

  it("refunds part, then everything left, never more, and audits who and why", async () => {
    const { payments, p } = await captured();
    expect(
      await refundAction(
        {},
        form({
          paymentId: p.id,
          amount: "500",
          requestId: "refund-r-1",
          reason: "Charger fault",
        }),
      ),
    ).toMatchObject({ ok: true, message: "Refunded €5.00 (500 minor units)." });
    const full = await refundAction(
      {},
      form({
        paymentId: p.id,
        full: "on",
        requestId: "refund-r-2",
        reason: "Goodwill",
      }),
    );
    expect(full).toMatchObject({
      ok: true,
      message: "Refunded €10.00 (1000 minor units).",
    });
    expect((await payments.get(p.id))!.refundedAmount).toBe(1500);
    expect(
      await refundAction(
        {},
        form({
          paymentId: p.id,
          full: "on",
          requestId: "refund-r-3",
          reason: "Again",
        }),
      ),
    ).toMatchObject({ ok: false, code: "above_captured" });
    expect(
      await refundAction(
        {},
        form({
          paymentId: p.id,
          amount: "1",
          requestId: "refund-r-4",
          reason: "Again",
        }),
      ),
    ).toMatchObject({ ok: false, code: "above_captured" });

    const refunds = await payments.listRefunds(p.id);
    expect(refunds.map((r) => [r.amount, r.reason, r.actor])).toEqual([
      [500, "Charger fault", "admin:secret"],
      [1000, "Goodwill", "admin:secret"],
    ]);
    const audit = await paymentAuditAction(
      {},
      form({ paymentId: p.commandId }),
    );
    expect(audit.payments![0].id).toBe(p.id);
    expect(audit.audit!.map((a) => [a.actor, a.action])).toEqual([
      ["admin:secret", "payment.refund_succeeded"],
      ["admin:secret", "payment.refund_succeeded"],
    ]);
    expect(audit.audit![0].details).toContain("reason: Goodwill");
    expect(audit.audit![1].details).toContain("amount: 500");
  });

  it("retries a full refund Stripe never answered with its own amount and key", async () => {
    Object.assign(process.env, LIVE_ENV);
    delete process.env.DEMO_MODE;
    const { payments, p } = await captured();
    await payments.transition(
      p.id,
      ["captured"],
      { paymentIntentId: "pi_test_1" },
      "2026-10-01T07:00:00.000Z",
    );
    const keys: string[] = [];
    const refund = vi.fn(async (input: { amount: number }, key: string) => {
      keys.push(key);
      if (keys.length === 1) throw new StripeUnknownError("refund: no answer");
      return { id: "re_test_1", status: "succeeded", amount: input.amount };
    });
    setStripeForTests({ refund } as unknown as StripeApi);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const full = form({
      paymentId: p.id,
      full: "on",
      requestId: "refund-full-1",
      reason: "Charger fault",
    });

    const first = await refundAction({}, full);
    expect(first).toMatchObject({ ok: false, code: "stripe_no_answer" });
    expect(requestIdSpent(first)).toBe(false);
    // 1,500 is reserved by the pending refund, with no Stripe ID yet.
    expect(await payments.listRefunds(p.id)).toEqual([
      expect.objectContaining({
        amount: 1500,
        status: "pending",
        stripeRefundId: null,
      }),
    ]);

    // The same form again: the same 1,500 and the same key, not "nothing left".
    const again = await refundAction({}, full);
    expect(again).toMatchObject({
      ok: true,
      message: "Refunded €15.00 (1500 minor units).",
    });
    expect(requestIdSpent(again)).toBe(true);
    expect(refund.mock.calls.map(([input]) => input.amount)).toEqual([
      1500, 1500,
    ]);
    expect(keys[1]).toBe(keys[0]);
    expect(await payments.listRefunds(p.id)).toEqual([
      expect.objectContaining({ amount: 1500, status: "succeeded" }),
    ]);
    expect((await payments.get(p.id))!.refundedAmount).toBe(1500);

    // A third send replays the settled refund: Stripe is not called again.
    expect(await refundAction({}, full)).toMatchObject({ ok: true });
    expect(refund).toHaveBeenCalledTimes(2);
    // A new request ID finds nothing left.
    expect(
      await refundAction(
        {},
        form({
          paymentId: p.id,
          full: "on",
          requestId: "refund-full-2",
          reason: "Again",
        }),
      ),
    ).toMatchObject({ ok: false, code: "above_captured" });
  });

  it("spends the form's request ID once the outcome is known, keeps it otherwise", () => {
    const shown = { payments: [] };
    for (const r of [
      { ok: true, ...shown },
      { ok: false, code: "refund_failed", ...shown },
      { ok: false, code: "refund_pending", ...shown },
      { ok: false, code: "refund_requires_action", ...shown },
      { ok: false, code: "stripe_card_declined" },
      { ok: false, code: "request_reused" },
    ])
      expect(requestIdSpent(r)).toBe(true);
    for (const r of [
      { ok: false, code: "stripe_no_answer" },
      { ok: false, code: "unexpected" },
      { ok: false, code: "invalid_input" },
      { ok: false, code: "above_captured" },
      { ok: false, code: "wrong_secret" },
    ])
      expect(requestIdSpent(r)).toBe(false);
  });
});

describe("the admin gate on reconciliation, audit, driver and refund actions", () => {
  const actions = {
    reconcileAction,
    paymentAuditAction,
    driverAccountAction,
    refundAction,
  };
  const raw = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };
  /** Signs a user in with `role` (an auth provider that knows one token). */
  function signIn(role: "admin" | "viewer") {
    const user = { id: crypto.randomUUID(), email: `${role}@example.com` };
    const token = `token-${user.id}`;
    setAuthProviderForTests({
      getUser: async (t: string) => (t === token ? user : null),
    } as unknown as AuthProvider);
    const accounts = new MemoryAccountStore();
    accounts.admins.set(user.id, role);
    setAccountStoreForTests(accounts);
    requestCookies.set(ADMIN_COOKIE, token);
    return { user, accounts };
  }
  const GATE = ["wrong_secret", "read_only", "admin_disabled", "rate_limited"];

  for (const [name, action] of Object.entries(actions)) {
    it(`${name}: refuses a missing or wrong secret and a viewer, lets an admin in`, async () => {
      setPaymentStoreForTests(new MemoryPaymentStore());
      expect(await action({}, raw({}))).toMatchObject({
        ok: false,
        code: "wrong_secret",
      });
      expect(
        await action({}, raw({ adminSecret: "x".repeat(32) })),
      ).toMatchObject({ ok: false, code: "wrong_secret" });

      // Without ADMIN_SECRET, nobody gets in without signing in.
      delete process.env.ADMIN_SECRET;
      expect(await action({}, raw({ adminSecret: SECRET }))).toMatchObject({
        ok: false,
        code: "admin_disabled",
      });

      signIn("viewer");
      expect(await action({}, raw({}))).toMatchObject({
        ok: false,
        code: "read_only",
      });

      signIn("admin");
      const r = await action({}, raw({}));
      expect(GATE).not.toContain(r.code);
    });
  }

  it("records the signed-in admin, not the secret, on a refund", async () => {
    delete process.env.ADMIN_SECRET;
    const { user } = signIn("admin");
    const payments = new MemoryPaymentStore();
    setPaymentStoreForTests(payments);
    const p = (await payments.insert(
      {
        commandId: crypto.randomUUID(),
        driverRef: "driver-1",
        currency: "EUR",
        holdAmount: 2500,
        paymentMethodId: null,
      },
      "2026-10-01T06:00:00.000Z",
    ))!;
    await payments.transition(
      p.id,
      ["pending"],
      { status: "captured", authorizedAmount: 2500, capturedAmount: 1500 },
      "2026-10-01T07:00:00.000Z",
    );
    expect(
      await refundAction(
        {},
        raw({
          paymentId: p.id,
          amount: "200",
          requestId: "refund-admin-1",
          reason: "Charger fault",
        }),
      ),
    ).toMatchObject({ ok: true });
    expect((await payments.listRefunds(p.id))[0].actor).toBe(
      `admin:${user.id}`,
    );
  });
});

describe("drivers: block and unblock", () => {
  it("blocks a driver from charging, audits it, and unblocks", async () => {
    const accounts = new MemoryAccountStore();
    await accounts.ensureDriver(
      DEMO_DRIVER_REF,
      "driver@example.com",
      "2026-10-01T00:00:00.000Z",
    );
    setAccountStoreForTests(accounts);
    const token = {
      type: "APP_USER",
      driverRef: DEMO_DRIVER_REF,
      id: "t1",
    } as Parameters<typeof driverStanding>[0];

    const blocked = await driverAccountAction(
      {},
      form({ driverRef: DEMO_DRIVER_REF, intent: "block" }),
    );
    expect(blocked).toMatchObject({
      ok: true,
      driver: { id: DEMO_DRIVER_REF, status: "restricted" },
    });
    expect(await driverStanding(token, accounts)).toBe("not_allowed");
    expect(
      await driverAccountAction(
        {},
        form({ driverRef: DEMO_DRIVER_REF, intent: "unblock" }),
      ),
    ).toMatchObject({ ok: true, driver: { status: "active" } });
    expect(
      (await peers.listAudit(DEMO_DRIVER_REF, 10)).map((a) => a.action),
    ).toEqual(["driver.unblock", "driver.block"]);
    // Never the card or the Stripe customer.
    expect(JSON.stringify(blocked)).not.toMatch(/pm_|cus_/);
  });

  it("explains a driver with no account", async () => {
    setAccountStoreForTests(new MemoryAccountStore());
    expect(
      await driverAccountAction(
        {},
        form({ driverRef: "nobody", intent: "block" }),
      ),
    ).toMatchObject({ ok: false, code: "not_found", nextStep: /tokens/ });
  });
});
