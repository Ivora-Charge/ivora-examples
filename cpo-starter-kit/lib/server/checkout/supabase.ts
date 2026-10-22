import "server-only";
import type { Database, Json } from "../database.types";
import { serviceClient } from "../supabase";
import {
  CheckoutError,
  UNSETTLED,
  type CheckoutAlert,
  type CheckoutChanges,
  type CheckoutKind,
  type CheckoutPhase,
  type CheckoutRecord,
  type CheckoutStore,
  type ClaimResult,
} from "./types";

type DbError = { message: string; code?: string } | null;
type Row = Database["public"]["Tables"]["cpo_checkouts"]["Row"];

function check<R extends { error: DbError }>(r: R): R {
  if (!r.error) return r;
  if (r.error.message.includes("cpo_invalid"))
    throw new CheckoutError("invalid", "Reload the page and try again.");
  if (r.error.message.includes("cpo_busy"))
    throw new CheckoutError(
      "in_use",
      "Someone else is starting a session on this connector right now. Nothing was charged.",
    );
  // Not the message: it can quote values. The Postgres code is enough to debug.
  throw new Error(
    `Supabase request failed (${r.error.code ?? "unknown"}). Check the migrations and keys.`,
  );
}

const COLUMNS =
  "id, operator_id, request_id, reference, kind, sticker_code, station_id, connector_id, tariff_id, hold_minor, currency, phase, bill_id, payment_id, checkout_url, start_requested_at, start_operation_id, transaction_id, stop_requested_at, stop_retried_at, meter_wh, meter_at, alert, final_minor, captured_minor, error, checked_at, settled_at, created_at, updated_at";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toRecord = (r: Row): CheckoutRecord => ({
  id: r.id,
  operatorId: r.operator_id,
  requestId: r.request_id,
  reference: r.reference,
  kind: r.kind as CheckoutKind,
  stickerCode: r.sticker_code,
  stationId: r.station_id,
  connectorId: r.connector_id,
  tariffId: r.tariff_id,
  holdMinor: r.hold_minor,
  currency: r.currency,
  phase: r.phase as CheckoutPhase,
  billId: r.bill_id,
  paymentId: r.payment_id,
  checkoutUrl: r.checkout_url,
  startRequestedAt: r.start_requested_at,
  startOperationId: r.start_operation_id,
  transactionId: r.transaction_id,
  stopRequestedAt: r.stop_requested_at,
  stopRetriedAt: r.stop_retried_at,
  meterWh: r.meter_wh,
  meterAt: r.meter_at,
  alert: r.alert as CheckoutAlert | null,
  finalMinor: r.final_minor,
  capturedMinor: r.captured_minor,
  error: r.error,
  checkedAt: r.checked_at,
  settledAt: r.settled_at,
  createdAt: r.created_at,
});

function changesJson(c: CheckoutChanges): Json {
  const out: Record<string, unknown> = {};
  if (c.phase !== undefined) out.phase = c.phase;
  if (c.billId !== undefined) out.bill_id = c.billId;
  if (c.holdMinor !== undefined) out.hold_minor = c.holdMinor;
  if (c.paymentId !== undefined) out.payment_id = c.paymentId;
  if (c.checkoutUrl !== undefined) out.checkout_url = c.checkoutUrl;
  if (c.startOperationId !== undefined)
    out.start_operation_id = c.startOperationId;
  if (c.transactionId !== undefined) out.transaction_id = c.transactionId;
  if (c.finalMinor !== undefined) out.final_minor = c.finalMinor;
  if (c.capturedMinor !== undefined) out.captured_minor = c.capturedMinor;
  if (c.error !== undefined) out.error = c.error;
  if (c.startRequested) out.start_requested = true;
  if (c.stopRequested) out.stop_requested = true;
  if (c.stopRetried) out.stop_retried = true;
  if (c.meterWh !== undefined) out.meter_wh = c.meterWh;
  if (c.alert !== undefined) out.alert = c.alert;
  if (c.checked) out.checked = true;
  return out as Json;
}

/**
 * Checkout records in Supabase (cpo_checkouts), service role only: drivers are not
 * staff, and the server checks the sticker, charger and price before every write.
 */
export function createSupabaseCheckoutStore(): CheckoutStore {
  const svc = () => serviceClient();
  const select = () => svc().from("cpo_checkouts").select(COLUMNS);
  const one = async (r: { data: unknown; error: DbError }) => {
    const { data } = check(r);
    return data ? toRecord(data as Row) : null;
  };
  return {
    mode: "live",
    async claim(n) {
      const { data } = check(
        await svc().rpc("cpo_claim_checkout", {
          p_operator_id: n.operatorId,
          p_request_id: n.requestId,
          p_kind: n.kind,
          p_sticker_code: n.stickerCode,
          p_station_id: n.stationId,
          p_connector_id: n.connectorId,
          p_tariff_id: n.tariffId,
          p_hold_minor: n.holdMinor,
          p_currency: n.currency,
        }),
      );
      return data as ClaimResult;
    },
    async get(operatorId, id) {
      if (!UUID.test(id)) return null;
      return one(
        await select().eq("operator_id", operatorId).eq("id", id).maybeSingle(),
      );
    },
    async getByRequest(operatorId, requestId) {
      if (!UUID.test(requestId)) return null;
      return one(
        await select()
          .eq("operator_id", operatorId)
          .eq("request_id", requestId.toLowerCase())
          .maybeSingle(),
      );
    },
    async getByReference(reference) {
      if (!/^ck_[0-9a-f]{32}$/.test(reference)) return null;
      return one(await select().eq("reference", reference).maybeSingle());
    },
    async listUnsettled(o) {
      let q = select().in("phase", [...UNSETTLED]);
      if (o.stationId) q = q.eq("station_id", o.stationId);
      const { data } = check(
        await q
          .order("checked_at", { ascending: true, nullsFirst: true })
          .limit(o.limit),
      );
      return ((data ?? []) as Row[]).map(toRecord);
    },
    async listAlerts(operatorId, o) {
      const since = new Date(Date.now() - o.days * 86_400_000).toISOString();
      const mine = () => select().eq("operator_id", operatorId);
      const [attention, alerted] = await Promise.all([
        mine()
          .eq("phase", "attention")
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(o.limit),
        mine()
          .not("alert", "is", null)
          .in("phase", [...UNSETTLED])
          .order("created_at", { ascending: false })
          .limit(o.limit),
      ]);
      return [
        ...((check(attention).data ?? []) as Row[]),
        ...((check(alerted).data ?? []) as Row[]),
      ]
        .map(toRecord)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, o.limit);
    },
    async record(operatorId, id, changes) {
      const { data } = check(
        await svc().rpc("cpo_record_checkout", {
          p_operator_id: operatorId,
          p_id: id,
          p_changes: changesJson(changes),
        }),
      );
      return data === true;
    },
  };
}
