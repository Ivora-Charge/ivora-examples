import "server-only";
import { minorDigits } from "@/lib/payments/money";
import type {
  PaymentReconciliationRow,
  PaymentStore,
} from "@/lib/payments/store";
import {
  reconcile,
  type Reconciliation,
  type ReconciliationTotal,
} from "@/lib/sessions/reconcile";
import type { ReconciliationRow, SessionStore } from "@/lib/sessions/store";

/**
 * CDR reconciliation for the admin web, per peer, UTC day and currency: what the
 * sessions said, what the CDRs billed (lib/sessions/reconcile.ts), and what the payments
 * captured and refunded for those CDRs (emsp_payment_reconciliation); with every
 * mismatch, the payments flagged for review, and a CSV export.
 *
 * Units: kWh and CPO amounts are E4 (ten-thousandths); payment amounts are minor units
 * of the currency. The CSV writes both as plain decimals.
 */
type PaymentSide = Omit<
  PaymentReconciliationRow,
  "peerId" | "day" | "currency"
>;

export type ReconciledDay = ReconciliationRow & PaymentSide;

export type ReconciledTotal = Omit<
  ReconciledDay,
  | "day"
  | "sessionsWithoutCdrIds"
  | "cdrsWithoutSessionIds"
  | "cdrsUnknownTokenIds"
  | "cdrsCurrencyMismatchIds"
  | "cdrsUnpaidIds"
  | "amountMismatchIds"
> & {
  /** Every mismatch of the group, added up: 0 means the peer and we agree. */
  mismatches: number;
};

export type ReconciliationReport = {
  from: string;
  to: string;
  days: ReconciledDay[];
  totals: ReconciledTotal[];
};

const NO_PAYMENTS: PaymentSide = {
  cdrsPaid: 0,
  cdrsUnpaid: 0,
  cdrsUnpaidIds: [],
  cdrAmount: 0,
  capturedAmount: 0,
  refundedAmount: 0,
  amountMismatches: 0,
  amountMismatchIds: [],
};

const dayKey = (r: { peerId: string; day: string; currency: string }) =>
  JSON.stringify([r.peerId, r.day, r.currency]);
const totalKey = (r: { peerId: string; currency: string }) =>
  JSON.stringify([r.peerId, r.currency]);

/** Every mismatch a row counts. */
export const mismatchesOf = (
  r: Pick<
    ReconciledDay,
    | "sessionsWithoutCdr"
    | "cdrsWithoutSession"
    | "cdrsUnknownToken"
    | "cdrsCurrencyMismatch"
    | "cdrsUnpaid"
    | "amountMismatches"
  >,
) =>
  r.sessionsWithoutCdr +
  r.cdrsWithoutSession +
  r.cdrsUnknownToken +
  r.cdrsCurrencyMismatch +
  r.cdrsUnpaid +
  r.amountMismatches;

const PAYMENT_NUMBERS = [
  "cdrsPaid",
  "cdrsUnpaid",
  "cdrAmount",
  "capturedAmount",
  "refundedAmount",
  "amountMismatches",
] as const;

/** Reconciliation of the UTC days `from` to `to`, inclusive; optionally one peer. */
export async function reconcileWithPayments(
  input: { from: string; to: string; peerId?: string },
  deps: { sessions: SessionStore; payments: PaymentStore },
): Promise<ReconciliationReport> {
  // Validates the days (ReconciliationError) before anything else is read.
  const base: Reconciliation = await reconcile(input, deps);
  const paid = await deps.payments.reconcileCdrs({
    from: `${base.from}T00:00:00.000Z`,
    to: new Date(Date.parse(`${base.to}T00:00:00Z`) + 86_400_000).toISOString(),
    peerId: input.peerId,
  });
  const byKey = new Map(paid.map((p) => [dayKey(p), p]));
  const days: ReconciledDay[] = base.days.map((d) => {
    const p = byKey.get(dayKey(d));
    byKey.delete(dayKey(d));
    return { ...d, ...(p ? paymentSide(p) : NO_PAYMENTS) };
  });
  // Every CDR group is in `base` already; anything left is a CDR that arrived between
  // the two reads. Keep it rather than drop money.
  for (const p of byKey.values())
    days.push({ ...emptyDay(p), ...paymentSide(p) });

  const totals = new Map<string, ReconciledTotal>();
  const totalOf = (t: ReconciliationTotal): ReconciledTotal => ({
    ...t,
    cdrsPaid: 0,
    cdrsUnpaid: 0,
    cdrAmount: 0,
    capturedAmount: 0,
    refundedAmount: 0,
    amountMismatches: 0,
    mismatches: 0,
  });
  for (const t of base.totals) totals.set(totalKey(t), totalOf(t));
  for (const d of days) {
    let t = totals.get(totalKey(d));
    if (!t) {
      const {
        day: _day,
        sessionsWithoutCdrIds: _s,
        cdrsWithoutSessionIds: _c,
        cdrsUnknownTokenIds: _u,
        cdrsCurrencyMismatchIds: _m,
        ...first
      } = emptyDay(d);
      totals.set(totalKey(d), (t = totalOf(first)));
    }
    for (const n of PAYMENT_NUMBERS) t[n] += d[n];
  }
  for (const t of totals.values()) t.mismatches = mismatchesOf(t);
  return { from: base.from, to: base.to, days, totals: [...totals.values()] };
}

function paymentSide(p: PaymentReconciliationRow): PaymentSide {
  const { peerId: _p, day: _d, currency: _c, ...side } = p;
  return side;
}

function emptyDay(p: {
  peerId: string;
  day: string;
  currency: string;
}): ReconciliationRow {
  return {
    peerId: p.peerId,
    day: p.day,
    currency: p.currency,
    sessions: 0,
    sessionsOpen: 0,
    sessionsCompleted: 0,
    sessionsInvalid: 0,
    sessionKwhE4: 0,
    sessionsWithoutCdr: 0,
    sessionsWithoutCdrIds: [],
    cdrs: 0,
    creditCdrs: 0,
    cdrsWithoutSession: 0,
    cdrsWithoutSessionIds: [],
    cdrsUnknownToken: 0,
    cdrsUnknownTokenIds: [],
    cdrsCurrencyMismatch: 0,
    cdrsCurrencyMismatchIds: [],
    cdrEnergyE4: 0,
    cdrCostExclVatE4: 0,
    cdrCostInclVatE4: 0,
  };
}

/** Whole `units` with `digits` decimals, as a plain decimal: (125000, 4) is "12.5". */
function decimal(units: number, digits: number, trim: boolean): string {
  const scale = 10 ** digits;
  const abs = Math.abs(units);
  let frac = digits ? String(abs % scale).padStart(digits, "0") : "";
  if (trim) frac = frac.replace(/0+$/, "");
  return `${units < 0 ? "-" : ""}${Math.floor(abs / scale)}${frac ? `.${frac}` : ""}`;
}

/** E4 (ten-thousandths) as a plain decimal: 125000 is "12.5". */
export const e4ToDecimal = (e4: number) => decimal(e4, 4, true);

/** Minor units as a plain decimal of the currency: 1235 EUR is "12.35". */
export const minorToDecimal = (minor: number, currency: string) =>
  decimal(minor, minorDigits(currency), false);

/**
 * One CSV cell. Text that a spreadsheet would read as a formula (it starts with =, +,
 * -, @, a tab or a carriage return) gets a leading apostrophe: IDs come from CPOs.
 */
export function csvCell(v: string | number | null): string {
  if (v === null) return "";
  if (typeof v === "number") return String(v);
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const CSV_COLUMNS = [
  "peer_id",
  "peer",
  "day",
  "currency",
  "sessions",
  "sessions_open",
  "sessions_completed",
  "sessions_invalid",
  "session_kwh",
  "sessions_without_cdr",
  "cdrs",
  "credit_cdrs",
  "cdr_kwh",
  "cdr_cost_excl_vat",
  "cdr_cost_incl_vat",
  "cdrs_without_session",
  "cdrs_unknown_token",
  "cdrs_currency_mismatch",
  "cdrs_paid",
  "cdr_amount_charged",
  "captured",
  "refunded",
  "net_captured",
  "cdrs_unpaid",
  "amount_mismatches",
  "sessions_without_cdr_ids",
  "cdrs_without_session_ids",
  "cdrs_unknown_token_ids",
  "cdrs_currency_mismatch_ids",
  "cdrs_unpaid_ids",
  "amount_mismatch_payment_ids",
] as const;

/** The days of a report as CSV (RFC 4180, CRLF line ends), one row per peer, day and currency. */
export function reconciliationCsv(
  report: ReconciliationReport,
  labels: Map<string, string>,
): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const d of report.days) {
    const money = (minor: number) => minorToDecimal(minor, d.currency);
    const cells: (string | number | null)[] = [
      d.peerId,
      labels.get(d.peerId) ?? "",
      d.day,
      d.currency,
      d.sessions,
      d.sessionsOpen,
      d.sessionsCompleted,
      d.sessionsInvalid,
      e4ToDecimal(d.sessionKwhE4),
      d.sessionsWithoutCdr,
      d.cdrs,
      d.creditCdrs,
      e4ToDecimal(d.cdrEnergyE4),
      e4ToDecimal(d.cdrCostExclVatE4),
      d.cdrCostInclVatE4 === null ? null : e4ToDecimal(d.cdrCostInclVatE4),
      d.cdrsWithoutSession,
      d.cdrsUnknownToken,
      d.cdrsCurrencyMismatch,
      d.cdrsPaid,
      money(d.cdrAmount),
      money(d.capturedAmount),
      money(d.refundedAmount),
      money(d.capturedAmount - d.refundedAmount),
      d.cdrsUnpaid,
      d.amountMismatches,
      d.sessionsWithoutCdrIds.join(" "),
      d.cdrsWithoutSessionIds.join(" "),
      d.cdrsUnknownTokenIds.join(" "),
      d.cdrsCurrencyMismatchIds.join(" "),
      d.cdrsUnpaidIds.join(" "),
      d.amountMismatchIds.join(" "),
    ];
    // Our own decimals stay numbers, a credit CDR's negative total too; any other text
    // goes through csvCell.
    lines.push(
      cells
        .map((c) =>
          typeof c === "string" && /^-?\d+(\.\d+)?$/.test(c) ? c : csvCell(c),
        )
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
