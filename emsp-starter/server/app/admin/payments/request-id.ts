import type { PaymentActionState } from "./actions";

/**
 * Whether the refund form's request ID is spent and the next refund needs a new one.
 * It is spent once the refund it names has a known outcome: done, failed, pending or
 * waiting at Stripe (the result shows the payment), refused by Stripe, or used for
 * another amount. It is kept while the outcome is unknown (Stripe gave no answer, or
 * the server failed), so sending the form again retries that same refund and never
 * refunds twice; and when nothing was sent (a wrong field or secret), where keeping it
 * changes nothing.
 */
export function requestIdSpent(r: PaymentActionState): boolean {
  if (r.code === "stripe_no_answer" || r.code === "unexpected") return false;
  return (
    r.payments !== undefined ||
    r.code === "request_reused" ||
    (r.code?.startsWith("stripe_") ?? false)
  );
}

/**
 * The request ID of the refund being made for each payment, for the life of the page
 * (memory only). A payment's panel can be closed and opened again, or found a second
 * time, and still sends the same ID until that refund's outcome is known.
 */
const refundIds = new Map<string, string>();

/** The request ID the refund form of this payment sends now. */
export function refundRequestId(paymentId: string): string {
  let id = refundIds.get(paymentId);
  if (!id) {
    id = crypto.randomUUID();
    refundIds.set(paymentId, id);
  }
  return id;
}

/** The outcome is known (requestIdSpent): the payment's next refund gets a new ID. */
export function spendRefundRequestId(paymentId: string): string {
  refundIds.delete(paymentId);
  return refundRequestId(paymentId);
}
