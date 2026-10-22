"use server";

import { paymentDeps } from "@/lib/payments/registry";
import {
  captureForReview,
  markReviewed,
  PaymentError,
  refundPayment,
  releaseForReview,
} from "@/lib/payments/settle";
import type { Payment, Refund } from "@/lib/payments/store";
import { asAdmin as gate, field } from "@/lib/server/admin-action";

/** A payment as the admin web shows it. Amounts in minor units; never card data. */
export type PaymentSummary = Pick<
  Payment,
  | "id"
  | "commandId"
  | "driverRef"
  | "status"
  | "currency"
  | "holdAmount"
  | "authorizedAmount"
  | "capturedAmount"
  | "refundedAmount"
  | "cdrAmount"
  | "cdrCurrency"
  | "review"
  | "shortfallAmount"
  | "reviewedAt"
  | "stopReason"
  | "error"
  | "createdAt"
> & {
  refunds?: Pick<
    Refund,
    "id" | "amount" | "status" | "reason" | "actor" | "createdAt"
  >[];
};

/** One audit log entry of a payment, newest first. */
export type AuditLine = {
  at: string;
  actor: string;
  action: string;
  /** The entry's details, as `key: value` pairs; never card data. */
  details: string;
};

export type PaymentActionState = {
  ok?: boolean;
  message?: string;
  code?: string;
  nextStep?: string;
  payments?: PaymentSummary[];
  audit?: AuditLine[];
};

const summary = (p: Payment, refunds?: Refund[]): PaymentSummary => ({
  id: p.id,
  commandId: p.commandId,
  driverRef: p.driverRef,
  status: p.status,
  currency: p.currency,
  holdAmount: p.holdAmount,
  authorizedAmount: p.authorizedAmount,
  capturedAmount: p.capturedAmount,
  refundedAmount: p.refundedAmount,
  cdrAmount: p.cdrAmount,
  cdrCurrency: p.cdrCurrency,
  review: p.review,
  shortfallAmount: p.shortfallAmount,
  reviewedAt: p.reviewedAt,
  stopReason: p.stopReason,
  error: p.error,
  createdAt: p.createdAt,
  refunds: refunds?.map((r) => ({
    id: r.id,
    amount: r.amount,
    status: r.status,
    reason: r.reason,
    actor: r.actor,
    createdAt: r.createdAt,
  })),
});

function asAdmin(
  form: FormData,
  fn: (actor: string) => Promise<PaymentActionState>,
): Promise<PaymentActionState> {
  return gate(form, fn, {
    shown: (e) => e instanceof PaymentError,
    fallback: "Something went wrong. Look the payment up before trying again.",
    what: "payment",
  });
}

const UUID = /^[0-9a-f-]{36}$/i;
const minor = (form: FormData) => {
  const v = field(form, "amount").trim();
  return /^\d{1,9}$/.test(v) ? Number(v) : NaN;
};

/** Payments waiting for a person, oldest first. */
export async function reviewListAction(
  _prev: PaymentActionState,
  form: FormData,
): Promise<PaymentActionState> {
  return asAdmin(form, async () => {
    const payments = (await paymentDeps("admin").payments.listReview(50)).map(
      (p) => summary(p),
    );
    return {
      ok: true,
      message: payments.length
        ? `${payments.length} payment(s) to review.`
        : "Nothing to review.",
      payments,
    };
  });
}

/** One payment, by its ID or its charge (START_SESSION command) ID, with refunds. */
export async function lookupPaymentAction(
  _prev: PaymentActionState,
  form: FormData,
): Promise<PaymentActionState> {
  return asAdmin(form, async () => {
    const id = field(form, "paymentId").trim().toLowerCase();
    if (!UUID.test(id))
      return { ok: false, message: "Enter a payment or charge ID." };
    const d = paymentDeps("admin");
    const p = (await d.payments.get(id)) ?? (await d.payments.getByCommand(id));
    if (!p) return { ok: false, message: "No such payment." };
    return {
      ok: true,
      message: "Payment found.",
      payments: [summary(p, await d.payments.listRefunds(p.id))],
    };
  });
}

/** What is left to refund: the capture, less every refund that did not fail. */
const refundable = (p: Payment, refunds: Refund[]) =>
  p.capturedAmount -
  refunds
    .filter((r) => r.status !== "failed")
    .reduce((sum, r) => sum + r.amount, 0);

/**
 * Refunds part or all ("full": everything left) of a captured payment, with a reason.
 * Capped at what was captured, and idempotent by the form's request ID (settle.ts).
 */
export async function refundAction(
  _prev: PaymentActionState,
  form: FormData,
): Promise<PaymentActionState> {
  return asAdmin(form, async (actor) => {
    const d = paymentDeps(actor);
    const paymentId = field(form, "paymentId").trim().toLowerCase();
    const requestId = field(form, "requestId");
    let amount = minor(form);
    if (field(form, "full") === "on") {
      if (!UUID.test(paymentId))
        return { ok: false, message: "Enter a payment ID." };
      const p = await d.payments.get(paymentId);
      if (!p) return { ok: false, message: "No such payment." };
      const refunds = await d.payments.listRefunds(p.id);
      // A retry of this form: send the refund it reserved again, with the same amount
      // and key. Recomputing would count that refund against itself and leave 0.
      const sent = refunds.find((r) => r.requestId === requestId);
      amount = sent ? sent.amount : refundable(p, refunds);
      if (amount <= 0)
        return {
          ok: false,
          message: "Nothing is left to refund on this payment.",
          code: "above_captured",
          nextStep: "Look the payment up to see its refunds.",
        };
    }
    const refund = await refundPayment(
      {
        paymentId,
        amount,
        requestId,
        reason: field(form, "reason"),
      },
      d,
    );
    const p = (await d.payments.get(refund.paymentId))!;
    return {
      ok: refund.status === "succeeded",
      message:
        refund.status === "succeeded"
          ? `Refunded ${refund.amount} (minor units).`
          : refund.status === "failed"
            ? "The refund failed."
            : refund.status === "requires_action"
              ? "The refund waits on the bank or the Stripe Dashboard; its webhook settles it."
              : "The refund is pending; its webhook settles it.",
      ...(refund.status === "failed" && {
        code: "refund_failed",
        nextStep:
          "Nothing was refunded. Check the payment in the Stripe Dashboard before trying again.",
      }),
      ...(refund.status === "requires_action" && {
        code: "refund_requires_action",
        nextStep:
          "Open the refund in the Stripe Dashboard; the webhook updates it here.",
      }),
      ...(refund.status === "pending" && {
        code: "refund_pending",
        nextStep:
          "Wait for the webhook, then look the payment up. Sending the same form again never refunds twice.",
      }),
      payments: [summary(p, await d.payments.listRefunds(p.id))],
    };
  });
}

const detailText = (details: Record<string, unknown> | undefined) =>
  Object.entries(details ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(
      ([k, v]) =>
        `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`,
    )
    .join(", ");

/** A payment, its refunds and its audit log: every change, who made it and why. */
export async function paymentAuditAction(
  _prev: PaymentActionState,
  form: FormData,
): Promise<PaymentActionState> {
  return asAdmin(form, async () => {
    const id = field(form, "paymentId").trim().toLowerCase();
    if (!UUID.test(id))
      return { ok: false, message: "Enter a payment or charge ID." };
    const d = paymentDeps("admin");
    const p = (await d.payments.get(id)) ?? (await d.payments.getByCommand(id));
    if (!p) return { ok: false, message: "No such payment." };
    const audit = (await d.peers.listAudit(p.id, 100)).map((e) => ({
      at: e.at,
      actor: e.actor,
      action: e.action,
      details: detailText(e.details),
    }));
    return {
      ok: true,
      message: audit.length
        ? `${audit.length} audit log entr${audit.length === 1 ? "y" : "ies"}, newest first.`
        : "No audit log entries for this payment.",
      payments: [summary(p, await d.payments.listRefunds(p.id))],
      audit,
    };
  });
}

/** Decides a held payment under review: capture (up to the hold), release, or done. */
export async function decideAction(
  _prev: PaymentActionState,
  form: FormData,
): Promise<PaymentActionState> {
  return asAdmin(form, async (actor) => {
    const d = paymentDeps(actor);
    const id = field(form, "paymentId").trim().toLowerCase();
    const intent = field(form, "intent");
    let p: Payment;
    if (intent === "capture")
      p = await captureForReview({ paymentId: id, amount: minor(form) }, d);
    else if (intent === "release") p = await releaseForReview(id, d);
    else if (intent === "reviewed") p = await markReviewed(id, d);
    else return { ok: false, message: "Unknown action." };
    return {
      ok: true,
      message:
        intent === "capture"
          ? `Captured ${p.capturedAmount} (minor units).`
          : intent === "release"
            ? "Hold released."
            : "Marked as reviewed.",
      payments: [summary(p)],
    };
  });
}
