import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listPeersAction, syncPeerAction } from "@/app/admin/peers/actions";
import { paymentAuditAction, refundAction } from "@/app/admin/payments/actions";
import { reconcileAction } from "@/app/admin/reconciliation/actions";
import { listSessionsAction } from "@/app/admin/sessions/actions";
import { driverAccountAction } from "@/app/admin/tokens/actions";
import { setAccountStoreForTests } from "@/lib/accounts/registry";
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
import { setPaymentStoreForTests } from "@/lib/payments/registry";
import { PaymentError } from "@/lib/payments/settle";
import { MemoryPaymentStore, type Payment } from "@/lib/payments/store";
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
    ).toMatchObject({ ok: true, message: "Refunded 500 (minor units)." });
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
      message: "Refunded 1000 (minor units).",
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
