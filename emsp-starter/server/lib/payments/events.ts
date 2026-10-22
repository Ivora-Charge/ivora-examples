import "server-only";

/**
 * Internal payment events, for the parts that tell the driver (the app, part 11) or
 * notify someone:
 *
 * - `hold_increment_declined`: a raise of a running session's hold was refused, so we
 *   asked the CPO to stop the session. `authorizedAmount` is what the card still
 *   covers, in minor units of `currency`; `stopReason` is stored on the session.
 * - `payment.captured`, `payment.released`: a payment settled.
 * - `payment.review`: a payment needs a person (see ReviewReason).
 *
 * Listeners run in this server process after the change, like session events; one
 * that throws is logged and skipped. Events carry IDs and amounts, never card data.
 */
export type PaymentEvent =
  | {
      type: "hold_increment_declined";
      paymentId: string;
      commandId: string;
      driverRef: string;
      sessionId: string | null;
      authorizedAmount: number;
      currency: string;
      stopReason: string;
    }
  | {
      type: "payment.captured" | "payment.released" | "payment.review";
      paymentId: string;
      commandId: string;
      driverRef: string;
    };

export type PaymentEventListener = (
  event: PaymentEvent,
) => Promise<void> | void;

const holder = globalThis as unknown as {
  __emspPaymentListeners?: Set<PaymentEventListener>;
};
const listeners = () => (holder.__emspPaymentListeners ??= new Set());

/** Calls `listener` for every payment event from now on. Returns the unsubscribe. */
export function onPaymentEvent(listener: PaymentEventListener): () => void {
  listeners().add(listener);
  return () => listeners().delete(listener);
}

/** Calls every listener with `event`, in order. Never throws. */
export async function emitPaymentEvent(event: PaymentEvent): Promise<void> {
  for (const listener of [...listeners()])
    try {
      await listener(structuredClone(event));
    } catch (e) {
      console.error(
        `A ${event.type} listener failed: ${e instanceof Error ? e.name : "unknown error"}`,
      );
    }
}
