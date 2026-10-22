import "server-only";
import type { CheckoutRecord } from "../checkout/types";
import { demoHistory } from "../ivora/demo-history";
import type { IvoraClient } from "../ivora/types";
import { matchesFilter, newestFirst, reportStatus, totalsOf } from "./records";
import type { ReportCheckout, ReportsStore } from "./types";

// Demo reports: six months of sample checkouts (demo-history.ts) and the visitor's own
// demo checkouts from their cookie, with their sessions' details from the demo Ivora
// client. All offline; there is no sweep to run, so nothing is due.

/** A visitor's demo checkout as reports read it; its details from the demo client. */
async function fromRecord(
  r: CheckoutRecord,
  ivora: IvoraClient,
): Promise<ReportCheckout> {
  const settled = r.phase === "settled" || r.phase === "attention";
  const tx =
    settled && r.transactionId !== null
      ? await ivora.getTransaction(r.transactionId).catch(() => null)
      : null;
  const ended = tx?.ended_at ? tx : null;
  const c: ReportCheckout = {
    id: r.id,
    reference: r.reference,
    kind: r.kind,
    stationId: r.stationId,
    connectorId: r.connectorId,
    phase: r.phase,
    alert: r.alert,
    createdAt: new Date(r.createdAt).toISOString(),
    settledAt: r.settledAt,
    transactionId: r.transactionId,
    billId: r.billId,
    holdMinor: r.holdMinor,
    currency: r.currency,
    finalMinor: r.finalMinor,
    capturedMinor: r.capturedMinor,
    refundedMinor: null,
    refundCheckedAt: null,
    meterWh: r.meterWh,
    sessionStartedAt: ended?.started_at ?? null,
    sessionEndedAt: ended?.ended_at ?? null,
    energyWh: ended?.energy_wh ?? null,
    connectorNumber: ended?.connector_number ?? null,
    stopReason: ended?.stop_reason ?? null,
    detailAt: ended ? (r.settledAt ?? r.createdAt) : null,
  };
  // Demo payments are never refunded: say so as if the sweep had read them.
  if (reportStatus(c) === "charged")
    return { ...c, refundedMinor: 0, refundCheckedAt: r.settledAt };
  return c;
}

export function createDemoReportsStore(o: {
  ivora: IvoraClient;
  /** The visitor's own demo checkouts (their cookie). */
  own: () => Promise<CheckoutRecord[]>;
  now: () => number;
}): ReportsStore {
  async function all(): Promise<ReportCheckout[]> {
    const own = await Promise.all(
      (await o.own()).map((r) => fromRecord(r, o.ivora)),
    );
    return [...own, ...demoHistory(o.now()).checkouts];
  }
  return {
    mode: "demo",
    async list(f, page) {
      let rows = (await all())
        .filter((c) => matchesFilter(c, f))
        .sort(newestFirst);
      const after = page.after;
      if (after) {
        const at = Date.parse(after.createdAt);
        rows = rows.filter((c) => {
          const t = Date.parse(c.createdAt);
          return t < at || (t === at && c.id < after.id);
        });
      }
      const from = Math.max(0, page.offset ?? 0);
      return rows.slice(from, from + Math.min(Math.max(page.limit, 1), 500));
    },
    async totals(f) {
      return totalsOf((await all()).filter((c) => matchesFilter(c, f)));
    },
    async detailsDue() {
      return [];
    },
    async recordDetails() {
      return false;
    },
    async refundsDue() {
      return [];
    },
    async recordRefund() {
      return false;
    },
  };
}
