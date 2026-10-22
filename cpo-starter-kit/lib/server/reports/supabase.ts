import "server-only";
import type {
  CheckoutAlert,
  CheckoutKind,
  CheckoutPhase,
} from "../checkout/types";
import type { Database } from "../database.types";
import { serviceClient } from "../supabase";
import type {
  ReportCheckout,
  ReportFilter,
  ReportsStore,
  ReportTotals,
} from "./types";

type DbError = { message: string; code?: string } | null;
type Row = Database["public"]["Tables"]["cpo_checkouts"]["Row"];

function check<R extends { error: DbError }>(r: R): R {
  if (!r.error) return r;
  // Not the message: it can quote values. The Postgres code is enough to debug.
  throw new Error(
    `Supabase request failed (${r.error.code ?? "unknown"}). Check the migrations and keys.`,
  );
}

const DAY_MS = 86_400_000;
/** The sweep copies details of sessions settled in the last 30 days. */
const DETAILS_DAYS = 30;
/** And reads each charged payment's refunds once a day for 90 days. */
const REFUND_DAYS = 90;

export const toReportCheckout = (r: Row): ReportCheckout => ({
  id: r.id,
  reference: r.reference,
  kind: r.kind as CheckoutKind,
  stationId: r.station_id,
  connectorId: r.connector_id,
  phase: r.phase as CheckoutPhase,
  alert: r.alert as CheckoutAlert | null,
  createdAt: new Date(r.created_at).toISOString(),
  settledAt: r.settled_at,
  transactionId: r.transaction_id,
  billId: r.bill_id,
  holdMinor: r.hold_minor,
  currency: r.currency,
  finalMinor: r.final_minor,
  capturedMinor: r.captured_minor,
  refundedMinor: r.refunded_minor,
  refundCheckedAt: r.refund_checked_at,
  meterWh: r.meter_wh,
  sessionStartedAt: r.session_started_at,
  sessionEndedAt: r.session_ended_at,
  energyWh: r.energy_wh,
  connectorNumber: r.connector_number,
  stopReason: r.stop_reason,
  detailAt: r.detail_at,
});

const int = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) ? v : 0;

/** cpo_report_totals' JSON as ReportTotals. */
export function toReportTotals(j: unknown): ReportTotals {
  const o = (j ?? {}) as Record<string, unknown>;
  const list = Array.isArray(o.currencies) ? o.currencies : [];
  return {
    checkouts: int(o.checkouts),
    paid: int(o.paid),
    free: int(o.free),
    withSession: int(o.with_session),
    byStatus: {
      in_progress: int(o.in_progress),
      charged: int(o.charged),
      no_charge: int(o.no_charge),
      attention: int(o.attention),
    },
    energyWh: int(o.energy_wh),
    detailsPending: int(o.details_pending),
    refundsUnchecked: int(o.refunds_unchecked),
    currencies: list.map((x) => {
      const c = x as Record<string, unknown>;
      return {
        currency: String(c.currency),
        charged: int(c.charged),
        billedMinor: int(c.billed_minor),
        capturedMinor: int(c.captured_minor),
        refundedMinor: int(c.refunded_minor),
      };
    }),
  };
}

const range = (f: ReportFilter) => ({
  p_operator_id: f.operatorId,
  p_from: new Date(f.fromMs).toISOString(),
  p_to: new Date(f.toMs).toISOString(),
  p_station_id: f.stationId,
  p_status: f.status,
});

/** The kit's checkouts for reports, service role only, through cpo_report_*. */
export function createSupabaseReportsStore(
  now: () => number = Date.now,
): ReportsStore {
  const svc = () => serviceClient();
  return {
    mode: "live",
    async list(f, page) {
      const { data } = check(
        await svc().rpc("cpo_report_checkouts", {
          ...range(f),
          p_limit: page.limit,
          p_offset: page.offset ?? 0,
          p_after_created_at: page.after?.createdAt ?? null,
          p_after_id: page.after?.id ?? null,
        }),
      );
      return ((data ?? []) as Row[]).map(toReportCheckout);
    },
    async totals(f) {
      const { data } = check(await svc().rpc("cpo_report_totals", range(f)));
      return toReportTotals(data);
    },
    async detailsDue(limit) {
      const since = new Date(now() - DETAILS_DAYS * DAY_MS).toISOString();
      const { data } = check(
        await svc()
          .from("cpo_checkouts")
          .select("id, operator_id, transaction_id")
          .is("detail_at", null)
          .not("transaction_id", "is", null)
          .in("phase", ["settled", "attention"])
          .gte("settled_at", since)
          .order("detail_checked_at", { ascending: true, nullsFirst: true })
          .limit(limit),
      );
      return (data ?? []).map((r) => ({
        operatorId: r.operator_id,
        id: r.id,
        transactionId: r.transaction_id!,
      }));
    },
    async recordDetails(operatorId, id, d) {
      const { data } = check(
        await svc().rpc("cpo_record_checkout_details", {
          p_operator_id: operatorId,
          p_id: id,
          p_started_at: d.startedAt,
          p_ended_at: d.endedAt,
          p_energy_wh: d.energyWh,
          p_connector_number: d.connectorNumber,
          p_stop_reason: d.stopReason,
        }),
      );
      return data === true;
    },
    async refundsDue(limit) {
      const since = new Date(now() - REFUND_DAYS * DAY_MS).toISOString();
      const stale = new Date(now() - DAY_MS).toISOString();
      const { data } = check(
        await svc()
          .from("cpo_checkouts")
          .select("id, operator_id, payment_id")
          .eq("kind", "paid")
          .eq("phase", "settled")
          .gt("captured_minor", 0)
          .not("payment_id", "is", null)
          .gte("settled_at", since)
          .or(`refund_checked_at.is.null,refund_checked_at.lt.${stale}`)
          .order("refund_checked_at", { ascending: true, nullsFirst: true })
          .limit(limit),
      );
      return (data ?? []).map((r) => ({
        operatorId: r.operator_id,
        id: r.id,
        paymentId: r.payment_id!,
      }));
    },
    async recordRefund(operatorId, id, refundedMinor) {
      const { data } = check(
        await svc().rpc("cpo_record_checkout_refund", {
          p_operator_id: operatorId,
          p_id: id,
          p_refunded_minor: refundedMinor,
        }),
      );
      return data === true;
    },
  };
}
