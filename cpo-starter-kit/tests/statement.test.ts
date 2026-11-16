import { describe, expect, it } from "vitest";
import type { FeeTerms } from "@/lib/network-fee";
import {
  buildStatement,
  STATEMENT_CSV_COLUMNS,
  statementCsv,
  statementRow,
  type StatementSession,
} from "@/lib/statement";

// A host's monthly statement: every total is the sum of its rows, per currency.

const PCT: FeeTerms = {
  mode: "percent",
  percentBps: 1000,
  perKwhMinor: 0,
  monthlyChargerFeeMinor: 1500,
  currency: "USD",
};
const KWH: FeeTerms = {
  mode: "per_kwh",
  percentBps: 0,
  perKwhMinor: 5,
  monthlyChargerFeeMinor: 0,
  currency: "CAD",
};

let n = 0;
const session = (o: Partial<StatementSession> = {}): StatementSession => ({
  reference: `ck_${String(++n).padStart(6, "0")}`,
  kind: "paid",
  status: "charged",
  createdAt: "2026-10-05T10:00:00.000Z",
  startedAt: "2026-10-05T10:01:00.000Z",
  endedAt: "2026-10-05T11:00:00.000Z",
  siteName: "Sample Site",
  chargerName: "SAMPLE-01",
  energyWh: 20_000,
  currency: "USD",
  capturedMinor: 1000,
  refundedMinor: 0,
  terms: PCT,
  ...o,
});

describe("statement rows", () => {
  it("a charged session: amount, fee, host share", () => {
    expect(statementRow(session())).toMatchObject({
      kind: "revenue",
      amountMinor: 1000,
      feeMinor: 100,
      feeRefundedMinor: 0,
      netFeeMinor: 100,
      hostShareMinor: 900,
    });
  });

  it("a refund returns the fee in proportion", () => {
    expect(statementRow(session({ refundedMinor: 250 }))).toMatchObject({
      amountMinor: 1000,
      refundedMinor: 250,
      feeMinor: 100,
      feeRefundedMinor: 25,
      netFeeMinor: 75,
      hostShareMinor: 675,
    });
  });

  it("free, released, in progress and unsettled sessions carry no money", () => {
    for (const s of [
      session({ kind: "free", capturedMinor: null }),
      session({ status: "no_charge", capturedMinor: 0 }),
      session({ status: "in_progress", capturedMinor: null }),
      session({ status: "attention", capturedMinor: null }),
    ]) {
      const r = statementRow(s);
      expect(r.kind).not.toBe("revenue");
      expect(r.amountMinor + r.netFeeMinor + r.hostShareMinor).toBe(0);
    }
  });

  it("a per-kWh fee waits for the energy, and is left out of the totals", () => {
    const s = buildStatement(
      [session({ terms: KWH, currency: "CAD", energyWh: null })],
      null,
      0,
    );
    expect(s.rows[0].kind).toBe("fee_pending");
    expect(s.totals[0]).toMatchObject({ sessions: 1, open: 1, amountMinor: 0 });
  });

  it("no fee terms: the host keeps the amount", () => {
    expect(statementRow(session({ terms: null }))).toMatchObject({
      feeMinor: 0,
      hostShareMinor: 1000,
    });
  });
});

describe("statement totals", () => {
  it("equal the sum of the session rows, per currency", () => {
    // A mixed month: USD percent sessions, CAD per-kWh sessions, refunds, free and
    // unsettled ones, with amounts that round both ways.
    const sessions: StatementSession[] = [];
    for (let i = 0; i < 60; i++) {
      const cad = i % 3 === 0;
      sessions.push(
        session({
          currency: cad ? "CAD" : "USD",
          terms: cad ? KWH : { ...PCT, percentBps: 725 },
          capturedMinor: i % 7 === 0 ? 0 : 50 + ((i * 397) % 2450),
          status:
            i % 7 === 0
              ? "no_charge"
              : i % 11 === 0
                ? "in_progress"
                : "charged",
          refundedMinor: i % 5 === 0 ? (i * 31) % 400 : 0,
          energyWh: 1_000 + ((i * 7919) % 60_000),
          kind: i % 13 === 0 ? "free" : "paid",
        }),
      );
    }
    const s = buildStatement(sessions, PCT, 4);
    for (const t of s.totals) {
      const rows = s.rows.filter(
        (r) => r.session.currency === t.currency && r.kind === "revenue",
      );
      const sum = (k: keyof (typeof rows)[number]) =>
        rows.reduce((a, r) => a + (r[k] as number), 0);
      expect(t.amountMinor).toBe(sum("amountMinor"));
      expect(t.refundedMinor).toBe(sum("refundedMinor"));
      expect(t.feeMinor).toBe(sum("feeMinor"));
      expect(t.feeRefundedMinor).toBe(sum("feeRefundedMinor"));
      expect(t.netFeeMinor).toBe(sum("netFeeMinor"));
      expect(t.hostShareMinor).toBe(sum("hostShareMinor"));
      // And the money adds up: revenue − refunds = net fee + host share.
      expect(t.amountMinor - t.refundedMinor).toBe(
        t.netFeeMinor + t.hostShareMinor,
      );
      expect(t.sessions).toBe(
        s.rows.filter((r) => r.session.currency === t.currency).length,
      );
    }
    expect(s.totals.map((t) => t.currency)).toEqual(["CAD", "USD"]);
  });

  it("the monthly charger fee is a line of its own, never taken from the share", () => {
    const s = buildStatement([session()], PCT, 3);
    expect(s.chargerFee).toEqual({
      chargers: 3,
      perChargerMinor: 1500,
      totalMinor: 4500,
      currency: "USD",
    });
    expect(s.totals[0].hostShareMinor).toBe(900);
    expect(
      buildStatement([], { ...PCT, monthlyChargerFeeMinor: 0 }, 3).chargerFee,
    ).toBeNull();
  });
});

describe("statement CSV", () => {
  it("has a fixed header, one line per session, totals and the charger fee", () => {
    const s = buildStatement(
      [
        session({ reference: "ck_a", refundedMinor: 250 }),
        session({ reference: "ck_b", kind: "free", capturedMinor: null }),
      ],
      PCT,
      2,
    );
    const lines = statementCsv(s).split("\r\n");
    expect(lines[0]).toBe(STATEMENT_CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(6); // header, 2 sessions, 1 total, charger fee, ""
    const col = (line: string, name: (typeof STATEMENT_CSV_COLUMNS)[number]) =>
      line.split(",")[STATEMENT_CSV_COLUMNS.indexOf(name)];
    expect(col(lines[1], "session_ref")).toBe("ck_a");
    expect(col(lines[1], "net_network_fee_minor")).toBe("75");
    expect(col(lines[1], "host_share_minor")).toBe("675");
    expect(col(lines[2], "network_fee_minor")).toBe("");
    expect(col(lines[3], "line")).toBe("total");
    expect(col(lines[3], "host_share_minor")).toBe("675");
    expect(col(lines[4], "line")).toBe("monthly_charger_fee");
    expect(col(lines[4], "amount_minor")).toBe("3000");
  });

  it("defuses spreadsheet formulas in names", () => {
    const csv = statementCsv(
      buildStatement([session({ chargerName: "=HYPERLINK(1)" })], null, 0),
    );
    expect(csv).toContain("'=HYPERLINK(1)");
  });
});
