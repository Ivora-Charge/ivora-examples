import "server-only";
import {
  eq,
  inList,
  supabaseRest,
  type SupabaseTransport,
} from "@/lib/server/supabase-rest";
import {
  REVIEW_REASONS,
  type NewPayment,
  type Payment,
  type PaymentPatch,
  type PaymentStatus,
  type PaymentStore,
  type Refund,
  type RefundStatus,
  type ReserveOutcome,
  type ReviewReason,
} from "./store";

type PaymentRow = {
  id: string;
  command_id: string;
  driver_ref: string;
  status: PaymentStatus;
  currency: string;
  hold_amount: number;
  authorized_amount: number;
  captured_amount: number;
  refunded_amount: number;
  payment_method_id: string | null;
  payment_intent_id: string | null;
  hold_expires_at: string | null;
  incremental_available: boolean;
  increments: number;
  release_after: string | null;
  cdr_id: string | null;
  cdr_currency: string | null;
  cdr_amount: number | null;
  review: ReviewReason | null;
  shortfall_amount: number | null;
  reviewed_at: string | null;
  stop_reason: string | null;
  error: string;
  receipt_sent_at: string | null;
  created_at: string;
  updated_at: string;
};

type RefundRow = {
  id: string;
  payment_id: string;
  request_id: string;
  amount: number;
  reason: string;
  status: RefundStatus;
  stripe_refund_id: string | null;
  actor: string;
  created_at: string;
  updated_at: string;
};

/** Postgres returns `+00:00`; the rest of the server works with `Z` ISO strings. */
const iso = (v: string) => new Date(v).toISOString();
const isoOrNull = (v: string | null) => (v === null ? null : iso(v));
/** bigint columns may come back as strings. */
const num = (v: number | string) => Number(v);
const numOrNull = (v: number | string | null) => (v === null ? null : num(v));

const payment = (r: PaymentRow): Payment => ({
  id: r.id,
  commandId: r.command_id,
  driverRef: r.driver_ref,
  status: r.status,
  currency: r.currency,
  holdAmount: num(r.hold_amount),
  authorizedAmount: num(r.authorized_amount),
  capturedAmount: num(r.captured_amount),
  refundedAmount: num(r.refunded_amount),
  paymentMethodId: r.payment_method_id,
  paymentIntentId: r.payment_intent_id,
  holdExpiresAt: isoOrNull(r.hold_expires_at),
  incrementalAvailable: r.incremental_available,
  increments: r.increments,
  releaseAfter: isoOrNull(r.release_after),
  cdrId: r.cdr_id,
  cdrCurrency: r.cdr_currency,
  cdrAmount: numOrNull(r.cdr_amount),
  review: r.review,
  shortfallAmount: numOrNull(r.shortfall_amount),
  reviewedAt: isoOrNull(r.reviewed_at),
  stopReason: r.stop_reason,
  error: r.error,
  receiptSentAt: isoOrNull(r.receipt_sent_at),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const refund = (r: RefundRow): Refund => ({
  id: r.id,
  paymentId: r.payment_id,
  requestId: r.request_id,
  amount: num(r.amount),
  reason: r.reason,
  status: r.status,
  stripeRefundId: r.stripe_refund_id,
  actor: r.actor,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const COLUMNS: Record<keyof PaymentPatch, keyof PaymentRow> = {
  status: "status",
  currency: "currency",
  holdAmount: "hold_amount",
  authorizedAmount: "authorized_amount",
  capturedAmount: "captured_amount",
  paymentMethodId: "payment_method_id",
  paymentIntentId: "payment_intent_id",
  holdExpiresAt: "hold_expires_at",
  incrementalAvailable: "incremental_available",
  increments: "increments",
  releaseAfter: "release_after",
  cdrId: "cdr_id",
  cdrCurrency: "cdr_currency",
  cdrAmount: "cdr_amount",
  review: "review",
  shortfallAmount: "shortfall_amount",
  reviewedAt: "reviewed_at",
  stopReason: "stop_reason",
  error: "error",
  receiptSentAt: "receipt_sent_at",
};

/**
 * Payments in Supabase Postgres (emsp_payments, emsp_payment_refunds,
 * emsp_stripe_events), through the Data API as the service role. Status changes are
 * compare-and-swap; a refund is reserved by emsp_payment_reserve_refund under a lock on
 * its payment.
 */
export class SupabasePaymentStore implements PaymentStore {
  private readonly rest: ReturnType<typeof supabaseRest>;

  constructor(
    url: string,
    serviceRoleKey: string,
    transport?: SupabaseTransport,
  ) {
    this.rest = supabaseRest(url, serviceRoleKey, transport);
  }

  async insert(p: NewPayment, now: string) {
    const [row] = await this.rest<PaymentRow[]>(
      "POST",
      "emsp_payments?on_conflict=command_id&select=*",
      {
        command_id: p.commandId,
        driver_ref: p.driverRef,
        currency: p.currency,
        hold_amount: p.holdAmount,
        payment_method_id: p.paymentMethodId,
        created_at: now,
        updated_at: now,
      },
      "resolution=ignore-duplicates,return=representation",
    );
    return row ? payment(row) : null;
  }

  private async many(filter: string): Promise<Payment[]> {
    const rows = await this.rest<PaymentRow[]>(
      "GET",
      `emsp_payments?${filter}&select=*`,
    );
    return rows.map(payment);
  }

  async get(id: string) {
    return (await this.many(`id=${eq(id)}`))[0] ?? null;
  }

  async getByCommand(commandId: string) {
    return (await this.many(`command_id=${eq(commandId)}`))[0] ?? null;
  }

  async getByIntent(paymentIntentId: string) {
    return (
      (await this.many(`payment_intent_id=${eq(paymentIntentId)}`))[0] ?? null
    );
  }

  async transition(
    id: string,
    from: readonly PaymentStatus[],
    patch: PaymentPatch,
    now: string,
    options: { ifIncrements?: number } = {},
  ) {
    const body: Record<string, unknown> = { updated_at: now };
    for (const [k, v] of Object.entries(patch))
      if (v !== undefined) body[COLUMNS[k as keyof PaymentPatch]] = v;
    let filter = `id=${eq(id)}&status=${inList([...from])}`;
    if (options.ifIncrements !== undefined)
      filter += `&increments=eq.${options.ifIncrements}`;
    const [row] = await this.rest<PaymentRow[]>(
      "PATCH",
      `emsp_payments?${filter}&select=*`,
      body,
      "return=representation",
    );
    return row ? payment(row) : null;
  }

  async claimReceipt(id: string, now: string) {
    const rows = await this.rest<{ id: string }[]>(
      "PATCH",
      `emsp_payments?id=${eq(id)}&receipt_sent_at=is.null&select=id`,
      { receipt_sent_at: now, updated_at: now },
      "return=representation",
    );
    return rows.length > 0;
  }

  listHeld(limit: number) {
    return this.many(`status=eq.held&order=created_at.asc&limit=${limit}`);
  }

  listReview(limit: number) {
    return this.many(
      `review=${inList([...REVIEW_REASONS])}&reviewed_at=is.null&order=created_at.asc&limit=${limit}`,
    );
  }

  listByDriver(driverRef: string, limit: number) {
    return this.many(
      `driver_ref=${eq(driverRef)}&order=created_at.desc&limit=${limit}`,
    );
  }

  async reserveRefund(input: {
    paymentId: string;
    requestId: string;
    amount: number;
    reason: string;
    actor: string;
  }): Promise<ReserveOutcome> {
    const [row] = await this.rest<
      { outcome: ReserveOutcome["outcome"]; refund: RefundRow | null }[]
    >("POST", "rpc/emsp_payment_reserve_refund", {
      p_payment_id: input.paymentId,
      p_request_id: input.requestId,
      p_amount: input.amount,
      p_reason: input.reason,
      p_actor: input.actor,
    });
    if (!row)
      throw new Error("Database request failed: emsp_payment_reserve_refund");
    return row.refund
      ? {
          outcome: row.outcome as "created" | "replayed",
          refund: refund(row.refund),
        }
      : { outcome: row.outcome as "exceeds" | "not_found", refund: null };
  }

  async settleRefund(
    refundId: string,
    status: RefundStatus,
    stripeRefundId: string | null,
  ) {
    const [row] = await this.rest<{ refund: RefundRow }[]>(
      "POST",
      "rpc/emsp_payment_settle_refund",
      {
        p_refund_id: refundId,
        p_status: status,
        p_stripe_refund_id: stripeRefundId,
      },
    );
    return row ? refund(row.refund) : null;
  }

  async getRefundByStripeId(stripeRefundId: string) {
    const [row] = await this.rest<RefundRow[]>(
      "GET",
      `emsp_payment_refunds?stripe_refund_id=${eq(stripeRefundId)}&select=*&limit=1`,
    );
    return row ? refund(row) : null;
  }

  async listRefunds(paymentId: string) {
    const rows = await this.rest<RefundRow[]>(
      "GET",
      `emsp_payment_refunds?payment_id=${eq(paymentId)}&select=*&order=created_at.asc`,
    );
    return rows.map(refund);
  }

  async hasEvent(id: string) {
    const rows = await this.rest<{ id: string }[]>(
      "GET",
      `emsp_stripe_events?id=${eq(id)}&select=id`,
    );
    return rows.length > 0;
  }

  async recordEvent(id: string, type: string) {
    const rows = await this.rest<{ id: string }[]>(
      "POST",
      "emsp_stripe_events?on_conflict=id&select=id",
      { id, type: type.slice(0, 100) },
      "resolution=ignore-duplicates,return=representation",
    );
    return rows.length > 0;
  }
}
