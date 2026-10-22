import "server-only";
import { randomUUID } from "node:crypto";

/**
 * Payments: one per START_SESSION command (the driver's charge request), from the
 * card hold placed before the start to its capture from the session's CDR, or its
 * release. Amounts are whole minor units of `currency`.
 *
 * Status:
 *
 * - `pending`: the hold is being placed.
 * - `held`: the card network authorised `authorizedAmount`.
 * - `failed`: no hold (the card was refused, or payments are not set up). Final.
 * - `captured`: `capturedAmount` was taken from the hold; refunds may follow. Final.
 * - `released`: the hold was cancelled and nothing charged. Final.
 * - `expired`: the card network dropped the hold before a CDR came. Final.
 *
 * `review` marks a payment a person must look at; nothing about it is charged
 * automatically. Every change is a compare-and-swap on the status.
 */
export const PAYMENT_STATUSES = [
  "pending",
  "held",
  "failed",
  "captured",
  "released",
  "expired",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const REVIEW_REASONS = [
  /** The CDR is above what the hold allowed: the hold was captured, the rest is not. */
  "cdr_above_hold",
  /** The CDR came after the card network dropped the hold: nothing was charged. */
  "hold_expired",
  /** The CDR's currency is not the hold's: nothing was charged; the hold is kept. */
  "currency_mismatch",
  /** The CDR gave no amount including VAT: the amount excluding VAT was captured. */
  "vat_unknown",
  /** A raise of the hold was refused during the session, which we then stopped. */
  "increment_declined",
  /** The CPO sent a credit CDR for this session: refund the driver if it is owed. */
  "credit_cdr",
  /** We never learnt whether the hold was placed. A webhook settles it. */
  "hold_unknown",
  /** The driver disputed the charge with their bank. */
  "dispute",
  /** Money was refunded outside this server (the Stripe Dashboard, say). */
  "refund_outside",
  /** Another CDR came for a start already settled from one (a correction, say). */
  "second_cdr",
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export type Payment = {
  id: string;
  commandId: string;
  driverRef: string;
  status: PaymentStatus;
  currency: string;
  holdAmount: number;
  authorizedAmount: number;
  capturedAmount: number;
  refundedAmount: number;
  paymentMethodId: string | null;
  paymentIntentId: string | null;
  holdExpiresAt: string | null;
  incrementalAvailable: boolean;
  increments: number;
  releaseAfter: string | null;
  cdrId: string | null;
  cdrCurrency: string | null;
  cdrAmount: number | null;
  review: ReviewReason | null;
  shortfallAmount: number | null;
  reviewedAt: string | null;
  stopReason: string | null;
  /** Safe to show: a Stripe error code or our own words. */
  error: string;
  receiptSentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewPayment = Pick<
  Payment,
  "commandId" | "driverRef" | "currency" | "holdAmount" | "paymentMethodId"
>;

export type PaymentPatch = Partial<
  Omit<
    Payment,
    | "id"
    | "commandId"
    | "driverRef"
    | "refundedAmount"
    | "createdAt"
    | "updatedAt"
  >
>;

/**
 * - `pending`: reserved. Without `stripeRefundId`, sent with no answer yet (the same
 *   request retries it); with one, Stripe has it and its webhook settles it.
 * - `requires_action`: Stripe needs something from the driver's bank or the Dashboard.
 * - `succeeded`, `failed` (Stripe's `canceled` too). A failed refund gives its amount
 *   back; Stripe may fail a refund that had succeeded.
 */
export const REFUND_STATUSES = [
  "pending",
  "requires_action",
  "succeeded",
  "failed",
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** Our status for a Stripe refund status. */
export const refundStatusOf = (stripe: string): RefundStatus =>
  stripe === "canceled"
    ? "failed"
    : (REFUND_STATUSES as readonly string[]).includes(stripe)
      ? (stripe as RefundStatus)
      : "pending";

/** A refund may move from pending or requires_action to any status, or succeeded to failed. */
export const refundMayMove = (from: RefundStatus, to: RefundStatus) =>
  from === "pending" ||
  from === "requires_action" ||
  (from === "succeeded" && to === "failed");

export type Refund = {
  id: string;
  paymentId: string;
  requestId: string;
  amount: number;
  reason: string;
  status: RefundStatus;
  stripeRefundId: string | null;
  actor: string;
  createdAt: string;
  updatedAt: string;
};

export type ReserveOutcome =
  | { outcome: "created" | "replayed"; refund: Refund }
  | { outcome: "exceeds" | "not_found"; refund: null };

export interface PaymentStore {
  /** Null when the command has a payment already: read it with getByCommand. */
  insert(p: NewPayment, now: string): Promise<Payment | null>;
  get(id: string): Promise<Payment | null>;
  getByCommand(commandId: string): Promise<Payment | null>;
  getByIntent(paymentIntentId: string): Promise<Payment | null>;
  /**
   * Changes a payment only while its status is one of `from` (and, with
   * `ifIncrements`, it has had that many raises). Null otherwise: read it again.
   */
  transition(
    id: string,
    from: readonly PaymentStatus[],
    patch: PaymentPatch,
    now: string,
    options?: { ifIncrements?: number },
  ): Promise<Payment | null>;
  /** Sets receiptSentAt only while it is unset: true for the one caller that did. */
  claimReceipt(id: string, now: string): Promise<boolean>;
  /** Held payments, oldest first. */
  listHeld(limit: number): Promise<Payment[]>;
  /** Payments marked for review that nobody has marked reviewed, oldest first. */
  listReview(limit: number): Promise<Payment[]>;
  listByDriver(driverRef: string, limit: number): Promise<Payment[]>;
  /**
   * Reserves a refund in one step: the refunds that are not failed, with this one, may
   * not exceed what was captured. The same request ID again returns its refund.
   */
  reserveRefund(input: {
    paymentId: string;
    requestId: string;
    amount: number;
    reason: string;
    actor: string;
  }): Promise<ReserveOutcome>;
  /**
   * Records a refund's status (as `refundMayMove` allows; else it is unchanged) and
   * recounts the payment's refunded amount from its succeeded refunds.
   */
  settleRefund(
    refundId: string,
    status: RefundStatus,
    stripeRefundId: string | null,
  ): Promise<Refund | null>;
  getRefundByStripeId(stripeRefundId: string): Promise<Refund | null>;
  listRefunds(paymentId: string): Promise<Refund[]>;
  /** True when this Stripe event was handled already. */
  hasEvent(id: string): Promise<boolean>;
  /** Records a handled Stripe event: true the first time, false for a redelivery. */
  recordEvent(id: string, type: string): Promise<boolean>;
}

const ms = (iso: string) => Date.parse(iso);

/** Payments in memory: for demo mode (nothing persists) and for tests. */
export class MemoryPaymentStore implements PaymentStore {
  readonly payments = new Map<string, Payment>();
  readonly refunds = new Map<string, Refund>();
  readonly events = new Set<string>();

  // No awaits before the writes: each check and write is one step, like a row lock.
  async insert(p: NewPayment, now: string) {
    for (const x of this.payments.values())
      if (x.commandId === p.commandId) return null;
    const payment: Payment = {
      ...structuredClone(p),
      id: randomUUID(),
      status: "pending",
      authorizedAmount: 0,
      capturedAmount: 0,
      refundedAmount: 0,
      paymentIntentId: null,
      holdExpiresAt: null,
      incrementalAvailable: false,
      increments: 0,
      releaseAfter: null,
      cdrId: null,
      cdrCurrency: null,
      cdrAmount: null,
      review: null,
      shortfallAmount: null,
      reviewedAt: null,
      stopReason: null,
      error: "",
      receiptSentAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.payments.set(payment.id, payment);
    return structuredClone(payment);
  }

  async get(id: string) {
    const p = this.payments.get(id);
    return p ? structuredClone(p) : null;
  }

  private find(test: (p: Payment) => boolean) {
    for (const p of this.payments.values())
      if (test(p)) return structuredClone(p);
    return null;
  }

  async getByCommand(commandId: string) {
    return this.find((p) => p.commandId === commandId);
  }

  async getByIntent(paymentIntentId: string) {
    return this.find((p) => p.paymentIntentId === paymentIntentId);
  }

  async transition(
    id: string,
    from: readonly PaymentStatus[],
    patch: PaymentPatch,
    now: string,
    options: { ifIncrements?: number } = {},
  ) {
    const p = this.payments.get(id);
    if (!p || !from.includes(p.status)) return null;
    if (
      options.ifIncrements !== undefined &&
      p.increments !== options.ifIncrements
    )
      return null;
    Object.assign(p, structuredClone(patch), { updatedAt: now });
    return structuredClone(p);
  }

  async claimReceipt(id: string, now: string) {
    const p = this.payments.get(id);
    if (!p || p.receiptSentAt) return false;
    p.receiptSentAt = now;
    return true;
  }

  private list(test: (p: Payment) => boolean, limit: number, newest = false) {
    return [...this.payments.values()]
      .filter(test)
      .sort((a, b) =>
        newest
          ? ms(b.createdAt) - ms(a.createdAt)
          : ms(a.createdAt) - ms(b.createdAt),
      )
      .slice(0, limit)
      .map((p) => structuredClone(p));
  }

  async listHeld(limit: number) {
    return this.list((p) => p.status === "held", limit);
  }

  async listReview(limit: number) {
    return this.list((p) => p.review !== null && !p.reviewedAt, limit);
  }

  async listByDriver(driverRef: string, limit: number) {
    return this.list((p) => p.driverRef === driverRef, limit, true);
  }

  async reserveRefund(input: {
    paymentId: string;
    requestId: string;
    amount: number;
    reason: string;
    actor: string;
  }): Promise<ReserveOutcome> {
    const p = this.payments.get(input.paymentId);
    if (!p) return { outcome: "not_found", refund: null };
    const mine = [...this.refunds.values()].filter((r) => r.paymentId === p.id);
    const held = mine.find((r) => r.requestId === input.requestId);
    if (held) return { outcome: "replayed", refund: structuredClone(held) };
    const reserved = mine
      .filter((r) => r.status !== "failed")
      .reduce((sum, r) => sum + r.amount, 0);
    if (p.status !== "captured" || reserved + input.amount > p.capturedAmount)
      return { outcome: "exceeds", refund: null };
    const now = new Date().toISOString();
    const refund: Refund = {
      id: randomUUID(),
      paymentId: p.id,
      requestId: input.requestId,
      amount: input.amount,
      reason: input.reason,
      status: "pending",
      stripeRefundId: null,
      actor: input.actor,
      createdAt: now,
      updatedAt: now,
    };
    this.refunds.set(refund.id, refund);
    return { outcome: "created", refund: structuredClone(refund) };
  }

  async settleRefund(
    refundId: string,
    status: RefundStatus,
    stripeRefundId: string | null,
  ) {
    const r = this.refunds.get(refundId);
    if (!r) return null;
    if (refundMayMove(r.status, status)) {
      Object.assign(r, {
        status,
        stripeRefundId: stripeRefundId ?? r.stripeRefundId,
        updatedAt: new Date().toISOString(),
      });
      const p = this.payments.get(r.paymentId)!;
      p.refundedAmount = [...this.refunds.values()]
        .filter((x) => x.paymentId === p.id && x.status === "succeeded")
        .reduce((sum, x) => sum + x.amount, 0);
    }
    return structuredClone(r);
  }

  async getRefundByStripeId(stripeRefundId: string) {
    for (const r of this.refunds.values())
      if (r.stripeRefundId === stripeRefundId) return structuredClone(r);
    return null;
  }

  async listRefunds(paymentId: string) {
    return [...this.refunds.values()]
      .filter((r) => r.paymentId === paymentId)
      .sort((a, b) => ms(a.createdAt) - ms(b.createdAt))
      .map((r) => structuredClone(r));
  }

  async hasEvent(id: string) {
    return this.events.has(id);
  }

  async recordEvent(id: string) {
    if (this.events.has(id)) return false;
    this.events.add(id);
    return true;
  }
}
