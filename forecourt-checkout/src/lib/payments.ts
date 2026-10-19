// The app's view of a card hold, independent of the provider. Stripe is the
// implementation today (src/lib/server/stripe.ts); a card terminal would be
// another (src/lib/terminal.ts, planned).

export type Hold = {
  id: string;
  status:
    "requires_capture" | "succeeded" | "canceled" | "processing" | "other";
  currency: string;
  /** The authorized amount, in cents. */
  amountCents: number;
  capturedCents: number;
  manualCapture: boolean;
  /** Application fee recorded on the capture, in cents. */
  applicationFeeCents: number;
  metadata: Record<string, string>;
};

export type CheckoutState = {
  id: string;
  status: "open" | "complete" | "expired";
  url: string | null;
  metadata: Record<string, string>;
  hold: Hold | null;
};

export type CheckoutRequest = {
  idempotencyKey: string;
  holdCents: number;
  currency: string;
  title: string;
  description: string;
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
};

export interface PaymentGateway {
  /** True when payments land on the site operator's account and the deployer takes a fee. */
  readonly chargesApplicationFee: boolean;
  /** Merchant account reference for Ivora (non-secret). */
  readonly merchantReference: string;
  readonly processor: string;
  createCheckout(
    request: CheckoutRequest,
  ): Promise<{ id: string; url: string }>;
  getCheckout(id: string): Promise<CheckoutState | null>;
  expireCheckout(id: string, idempotencyKey: string): Promise<void>;
  /** Small per-session notes the app keeps with the payment (no personal data). */
  setHoldMetadata(
    holdId: string,
    values: Record<string, string>,
  ): Promise<void>;
  capture(
    holdId: string,
    amountCents: number,
    applicationFeeCents: number,
    idempotencyKey: string,
  ): Promise<Hold>;
  release(holdId: string, idempotencyKey: string): Promise<Hold>;
}
