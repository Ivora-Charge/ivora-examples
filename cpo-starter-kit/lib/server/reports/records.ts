import "server-only";
import type {
  CurrencyTotals,
  ReportCheckout,
  ReportCursor,
  ReportFilter,
  ReportStatus,
  ReportTotals,
} from "./types";

// The rules the database's cpo_report_status and cpo_report_totals apply, for the
// demo store (and its tests). Keep the two in step.

const UNSETTLED = new Set(["creating", "open", "settling", "releasing"]);

export function reportStatus(
  c: Pick<ReportCheckout, "phase" | "kind" | "capturedMinor">,
): ReportStatus {
  if (UNSETTLED.has(c.phase)) return "in_progress";
  if (
    (c.phase === "settled" || c.phase === "attention") &&
    c.kind === "paid" &&
    (c.capturedMinor ?? 0) > 0
  )
    return "charged";
  if (c.phase === "attention") return "attention";
  return "no_charge";
}

export function matchesFilter(c: ReportCheckout, f: ReportFilter): boolean {
  const made = Date.parse(c.createdAt);
  if (!(made >= f.fromMs && made < f.toMs)) return false;
  if (f.stationId !== null && c.stationId !== f.stationId) return false;
  if (f.status === "all") return true;
  if (f.status === "refunded") return (c.refundedMinor ?? 0) > 0;
  return reportStatus(c) === f.status;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Newest first, then by ID (the database's order). `cursor` is the full timestamp;
 * the demo's and the tests' cursors are UTC ISO text of one length, so text order is
 * time order.
 */
export function newestFirst(a: ReportCheckout, b: ReportCheckout): number {
  return cmp(b.cursor, a.cursor) || cmp(b.id, a.id);
}

/** The rows after a keyset cursor, in newestFirst order. */
export const afterCursor = (c: ReportCheckout, after: ReportCursor) =>
  c.cursor < after.at || (c.cursor === after.at && c.id < after.id);

export function totalsOf(rows: ReportCheckout[]): ReportTotals {
  const byStatus: Record<ReportStatus, number> = {
    in_progress: 0,
    charged: 0,
    no_charge: 0,
    attention: 0,
  };
  const money = new Map<string, CurrencyTotals>();
  let energyWh = 0;
  let detailsPending = 0;
  let refundsUnchecked = 0;
  for (const c of rows) {
    const status = reportStatus(c);
    byStatus[status] += 1;
    if (c.detailAt !== null) energyWh += c.energyWh ?? 0;
    if (c.transactionId !== null && c.detailAt === null) detailsPending += 1;
    if (status === "charged" && c.refundCheckedAt === null)
      refundsUnchecked += 1;
    if (
      c.kind === "paid" &&
      (c.phase === "settled" || c.phase === "attention")
    ) {
      const m = money.get(c.currency) ?? {
        currency: c.currency,
        charged: 0,
        billedMinor: 0,
        capturedMinor: 0,
        refundedMinor: 0,
      };
      if (status === "charged") m.charged += 1;
      m.billedMinor += c.finalMinor ?? 0;
      m.capturedMinor += c.capturedMinor ?? 0;
      m.refundedMinor += c.refundedMinor ?? 0;
      money.set(c.currency, m);
    }
  }
  return {
    checkouts: rows.length,
    paid: rows.filter((c) => c.kind === "paid").length,
    free: rows.filter((c) => c.kind === "free").length,
    withSession: rows.filter((c) => c.transactionId !== null).length,
    byStatus,
    energyWh,
    detailsPending,
    refundsUnchecked,
    currencies: [...money.values()].sort((a, b) =>
      a.currency.localeCompare(b.currency),
    ),
  };
}
