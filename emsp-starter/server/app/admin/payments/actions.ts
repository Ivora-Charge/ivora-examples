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
> & { refunds?: Pick<Refund, "id" | "amount" | "status" | "reason">[] };

export type PaymentActionState = {
  ok?: boolean;
  message?: string;
  payments?: PaymentSummary[];
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
  })),
});

function asAdmin(
  form: FormData,
  fn: () => Promise<PaymentActionState>,
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

/** Refunds part or all of a captured payment. */
export async function refundAction(
  _prev: PaymentActionState,
  form: FormData,
): Promise<PaymentActionState> {
  return asAdmin(form, async () => {
    const d = paymentDeps("admin");
    const refund = await refundPayment(
      {
        paymentId: field(form, "paymentId").trim().toLowerCase(),
        amount: minor(form),
        requestId: field(form, "requestId"),
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
      payments: [summary(p, await d.payments.listRefunds(p.id))],
    };
  });
}

/** Decides a held payment under review: capture (up to the hold), release, or done. */
export async function decideAction(
  _prev: PaymentActionState,
  form: FormData,
): Promise<PaymentActionState> {
  return asAdmin(form, async () => {
    const d = paymentDeps("admin");
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
