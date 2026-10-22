import "server-only";
import type { Database, Json } from "../database.types";
import { serviceClient } from "../supabase";
import {
  CheckoutError,
  type CheckoutChanges,
  type CheckoutPhase,
  type CheckoutRecord,
  type CheckoutStore,
} from "./types";

type DbError = { message: string; code?: string } | null;
type Row = Database["public"]["Tables"]["cpo_checkouts"]["Row"];

function check<R extends { error: DbError }>(r: R): R {
  if (!r.error) return r;
  if (r.error.message.includes("cpo_invalid"))
    throw new CheckoutError("invalid", "Reload the page and try again.");
  // Not the message: it can quote values. The Postgres code is enough to debug.
  throw new Error(
    `Supabase request failed (${r.error.code ?? "unknown"}). Check the migrations and keys.`,
  );
}

const COLUMNS =
  "id, operator_id, request_id, sticker_code, station_id, connector_id, tariff_id, hold_minor, currency, phase, bill_id, payment_id, checkout_url, start_requested_at, error, created_at, updated_at";

const toRecord = (r: Row): CheckoutRecord => ({
  id: r.id,
  operatorId: r.operator_id,
  requestId: r.request_id,
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
  error: r.error,
  createdAt: r.created_at,
});

function changesJson(c: CheckoutChanges): Json {
  const out: Record<string, unknown> = {};
  if (c.phase !== undefined) out.phase = c.phase;
  if (c.billId !== undefined) out.bill_id = c.billId;
  if (c.paymentId !== undefined) out.payment_id = c.paymentId;
  if (c.checkoutUrl !== undefined) out.checkout_url = c.checkoutUrl;
  if (c.error !== undefined) out.error = c.error;
  if (c.startRequested) out.start_requested = true;
  return out as Json;
}

/**
 * Checkout records in Supabase (cpo_checkouts), service role only: drivers are not
 * staff, and the server checks the sticker, charger and price before every write.
 */
export function createSupabaseCheckoutStore(): CheckoutStore {
  const svc = () => serviceClient();
  return {
    mode: "live",
    async claim(n) {
      const { data } = check(
        await svc().rpc("cpo_claim_checkout", {
          p_operator_id: n.operatorId,
          p_request_id: n.requestId,
          p_sticker_code: n.stickerCode,
          p_station_id: n.stationId,
          p_connector_id: n.connectorId,
          p_tariff_id: n.tariffId,
          p_hold_minor: n.holdMinor,
          p_currency: n.currency,
        }),
      );
      return data as { id: string; created: boolean };
    },
    async get(operatorId, id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const { data } = check(
        await svc()
          .from("cpo_checkouts")
          .select(COLUMNS)
          .eq("operator_id", operatorId)
          .eq("id", id)
          .maybeSingle(),
      );
      return data ? toRecord(data as Row) : null;
    },
    async record(operatorId, id, changes) {
      check(
        await svc().rpc("cpo_record_checkout", {
          p_operator_id: operatorId,
          p_id: id,
          p_changes: changesJson(changes),
        }),
      );
    },
  };
}
