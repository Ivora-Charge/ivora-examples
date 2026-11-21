import {
  feeRefunded,
  networkFee,
  type FeeResult,
  type FeeTerms,
} from "./network-fee";

// Network mode: a site host's monthly statement, built from the kit's own session
// records. Pure: the server reads the sessions (with the fee terms in effect when each
// one started) and this works out every row and the totals. Totals are the sums of the
// rows, nothing else, so a statement always adds up. Integer minor units throughout,
// per currency: amounts in different currencies are never added together.

/** A session as the statement reads it (one of the kit's checkouts at the host's sites). */
export interface StatementSession {
  /** The checkout's reference (ck_…). */
  reference: string;
  kind: "paid" | "free";
  /** As in Reports: in_progress, charged, no_charge or attention. */
  status: "in_progress" | "charged" | "no_charge" | "attention";
  /** When the driver tapped (UTC, ISO 8601): the month a session belongs to. */
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  siteName: string | null;
  chargerName: string;
  /** Recorded once the session ended; null until then. */
  energyWh: number | null;
  currency: string;
  /** What was captured (null while unsettled). */
  capturedMinor: number | null;
  refundedMinor: number | null;
  /**
   * The host's fee terms in effect when the session started (a change applies to
   * sessions started after it). Null: no terms were set, so no fee.
   */
  terms: FeeTerms | null;
}

/**
 * revenue: a paid session that captured money. no_charge: nothing to share (free,
 * released, under the minimum charge). in_progress: not settled yet, so not counted.
 * fee_pending: charged, but its per-kWh fee waits for the session's energy.
 */
export type StatementRowKind =
  "revenue" | "no_charge" | "in_progress" | "fee_pending";

export interface StatementRow {
  session: StatementSession;
  kind: StatementRowKind;
  /** The session amount: what was captured. 0 for sessions with no money. */
  amountMinor: number;
  refundedMinor: number;
  /** The network fee on the amount, before refunds. */
  feeMinor: number;
  /** The part of the fee returned with refunds (in proportion). */
  feeRefundedMinor: number;
  /** feeMinor − feeRefundedMinor. */
  netFeeMinor: number;
  /** amount − refunds − net fee: what the host keeps. */
  hostShareMinor: number;
  /** Why a row carries no money, or what is still open. */
  note: string | null;
}

export interface StatementTotals {
  currency: string;
  /** Every session in the month, paid or free. */
  sessions: number;
  /** Sessions that captured money. */
  charged: number;
  energyWh: number;
  amountMinor: number;
  refundedMinor: number;
  feeMinor: number;
  feeRefundedMinor: number;
  netFeeMinor: number;
  hostShareMinor: number;
  /** Rows not counted yet: in progress, or a per-kWh fee waiting for energy. */
  open: number;
}

export interface ChargerFeeLine {
  chargers: number;
  perChargerMinor: number;
  totalMinor: number;
  currency: string;
}

export interface Statement {
  rows: StatementRow[];
  /** One per currency, by currency code. */
  totals: StatementTotals[];
  /** The fixed monthly fee per charger: shown, never collected by the kit. */
  chargerFee: ChargerFeeLine | null;
}

const NOTES: Record<string, string> = {
  free: "Free session: no money",
  no_charge: "Nothing charged (hold released or under the minimum charge)",
  attention: "Needs the operator: nothing captured yet",
  in_progress: "In progress: counted once settled",
  energy: "Network fee waits for the session's energy",
  currency: "Per-kWh fee is set in another currency: no fee",
};

const zero = (s: StatementSession, kind: StatementRowKind, note: string) => ({
  session: s,
  kind,
  amountMinor: 0,
  refundedMinor: 0,
  feeMinor: 0,
  feeRefundedMinor: 0,
  netFeeMinor: 0,
  hostShareMinor: 0,
  note,
});

/** One session's row: the amount, the network fee, refunds and the host's share. */
export function statementRow(s: StatementSession): StatementRow {
  if (s.kind === "free") return zero(s, "no_charge", NOTES.free);
  if (s.status === "in_progress")
    return zero(s, "in_progress", NOTES.in_progress);
  const captured = s.capturedMinor ?? 0;
  if (captured <= 0)
    return zero(
      s,
      "no_charge",
      s.status === "attention" ? NOTES.attention : NOTES.no_charge,
    );
  const refunded = Math.min(Math.max(s.refundedMinor ?? 0, 0), captured);
  const fee: FeeResult = s.terms
    ? networkFee(s.terms, {
        capturedMinor: captured,
        energyWh: s.energyWh,
        currency: s.currency,
      })
    : { ok: true, feeMinor: 0, hostShareMinor: captured };
  if (!fee.ok && fee.reason === "energy")
    return {
      ...zero(s, "fee_pending", NOTES.energy),
      amountMinor: captured,
      refundedMinor: refunded,
    };
  const feeMinor = fee.ok ? fee.feeMinor : 0;
  const back = feeRefunded(feeMinor, captured, refunded);
  const netFee = feeMinor - back;
  return {
    session: s,
    kind: "revenue",
    amountMinor: captured,
    refundedMinor: refunded,
    feeMinor,
    feeRefundedMinor: back,
    netFeeMinor: netFee,
    hostShareMinor: captured - refunded - netFee,
    note: fee.ok ? null : NOTES.currency,
  };
}

/** Each currency's totals: the sums of its rows. */
export function statementTotals(rows: StatementRow[]): StatementTotals[] {
  const by = new Map<string, StatementTotals>();
  for (const r of rows) {
    const c = r.session.currency;
    const t =
      by.get(c) ??
      by
        .set(c, {
          currency: c,
          sessions: 0,
          charged: 0,
          energyWh: 0,
          amountMinor: 0,
          refundedMinor: 0,
          feeMinor: 0,
          feeRefundedMinor: 0,
          netFeeMinor: 0,
          hostShareMinor: 0,
          open: 0,
        })
        .get(c)!;
    t.sessions += 1;
    if (r.kind === "revenue") t.charged += 1;
    if (r.kind === "in_progress" || r.kind === "fee_pending") t.open += 1;
    t.energyWh += r.session.energyWh ?? 0;
    // A row whose fee is still open is left out of the money, so the totals never
    // show an amount without its fee.
    if (r.kind !== "revenue") continue;
    t.amountMinor += r.amountMinor;
    t.refundedMinor += r.refundedMinor;
    t.feeMinor += r.feeMinor;
    t.feeRefundedMinor += r.feeRefundedMinor;
    t.netFeeMinor += r.netFeeMinor;
    t.hostShareMinor += r.hostShareMinor;
  }
  return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * A host's statement for one month: its sessions (newest first, as given), the totals,
 * and the monthly charger fee line from `monthTerms` (the terms in effect at the
 * month's end) and the number of chargers at the host's sites.
 */
export function buildStatement(
  sessions: StatementSession[],
  monthTerms: FeeTerms | null,
  chargers: number,
): Statement {
  const rows = sessions.map(statementRow);
  const fee = monthTerms?.monthlyChargerFeeMinor ?? 0;
  return {
    rows,
    totals: statementTotals(rows),
    chargerFee:
      monthTerms && fee > 0
        ? {
            chargers,
            perChargerMinor: fee,
            totalMinor: fee * chargers,
            currency: monthTerms.currency,
          }
        : null,
  };
}

// ---- CSV ----

export const STATEMENT_CSV_COLUMNS = [
  "line",
  "session_ref",
  "session_type",
  "status",
  "created_at_utc",
  "started_at_utc",
  "ended_at_utc",
  "site",
  "charger",
  "energy_wh",
  "currency",
  "amount_minor",
  "refunded_minor",
  "network_fee_minor",
  "fee_refunded_minor",
  "net_network_fee_minor",
  "host_share_minor",
  "note",
] as const;

/** One CSV field (RFC 4180), with spreadsheet formulas defused as in Reports' export. */
export function csvField(v: string | number | null): string {
  if (v === null) return "";
  if (typeof v === "number") return String(v);
  const safe = /^[\s=+\-@＝＋－＠]/u.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

type Fields = Record<
  (typeof STATEMENT_CSV_COLUMNS)[number],
  string | number | null
>;

const line = (f: Partial<Fields>) =>
  `${STATEMENT_CSV_COLUMNS.map((c) => csvField(f[c] ?? null)).join(",")}\r\n`;

/**
 * The statement as CSV: one `session` line per row, one `total` line per currency
 * (the sums of its session lines), and a `monthly_charger_fee` line when there is one
 * (its amount in `amount_minor`; never collected by the kit). CRLF line ends.
 */
export function statementCsv(s: Statement): string {
  let out = `${STATEMENT_CSV_COLUMNS.join(",")}\r\n`;
  for (const r of s.rows) {
    const x = r.session;
    const money = r.kind === "revenue";
    out += line({
      line: "session",
      session_ref: x.reference,
      session_type: x.kind,
      status: x.status,
      created_at_utc: x.createdAt,
      started_at_utc: x.startedAt,
      ended_at_utc: x.endedAt,
      site: x.siteName,
      charger: x.chargerName,
      energy_wh: x.energyWh,
      currency: x.currency,
      amount_minor: r.amountMinor,
      refunded_minor: r.refundedMinor,
      network_fee_minor: money ? r.feeMinor : null,
      fee_refunded_minor: money ? r.feeRefundedMinor : null,
      net_network_fee_minor: money ? r.netFeeMinor : null,
      host_share_minor: money ? r.hostShareMinor : null,
      note: r.note,
    });
  }
  for (const t of s.totals)
    out += line({
      line: "total",
      energy_wh: t.energyWh,
      currency: t.currency,
      amount_minor: t.amountMinor,
      refunded_minor: t.refundedMinor,
      network_fee_minor: t.feeMinor,
      fee_refunded_minor: t.feeRefundedMinor,
      net_network_fee_minor: t.netFeeMinor,
      host_share_minor: t.hostShareMinor,
      note: `${t.sessions} sessions, ${t.charged} charged${t.open ? `, ${t.open} not counted yet` : ""}`,
    });
  if (s.chargerFee)
    out += line({
      line: "monthly_charger_fee",
      currency: s.chargerFee.currency,
      amount_minor: s.chargerFee.totalMinor,
      note: `${s.chargerFee.chargers} chargers × ${s.chargerFee.perChargerMinor} minor units; not collected by the kit`,
    });
  return out;
}
