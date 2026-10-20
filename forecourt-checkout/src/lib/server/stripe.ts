import "server-only";
import Stripe from "stripe";
import type {
  CheckoutRequest,
  CheckoutState,
  Hold,
  PaymentGateway,
} from "../payments";

function toHold(pi: Stripe.PaymentIntent): Hold {
  const known = [
    "requires_capture",
    "succeeded",
    "canceled",
    "processing",
  ] as const;
  const status = known.find((s) => s === pi.status) ?? "other";
  return {
    id: pi.id,
    status,
    currency: pi.currency,
    amountCents: pi.amount,
    capturedCents: pi.amount_received,
    manualCapture: pi.capture_method === "manual",
    applicationFeeCents: pi.application_fee_amount ?? 0,
    metadata: { ...pi.metadata },
  };
}

/**
 * Card holds through Stripe Checkout with manual capture. Apple Pay and
 * Google Pay appear in Checkout for the card method once enabled in the
 * Stripe Dashboard. With a connected account, charges are direct charges on
 * the site operator's account and the deployer's fee is the application fee.
 */
export class StripeGateway implements PaymentGateway {
  readonly processor = "stripe";
  readonly chargesApplicationFee: boolean;
  readonly merchantReference: string;
  private readonly stripe: Stripe;
  private readonly options: Stripe.RequestOptions;

  constructor(secretKey: string, connectedAccount: string) {
    this.stripe = new Stripe(secretKey, {
      maxNetworkRetries: 2,
      timeout: 15_000,
    });
    this.chargesApplicationFee = Boolean(connectedAccount);
    this.merchantReference = connectedAccount || "platform";
    this.options = connectedAccount ? { stripeAccount: connectedAccount } : {};
  }

  async createCheckout(request: CheckoutRequest) {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "payment",
        // Card covers Apple Pay and Google Pay; both support manual capture.
        allowed_payment_method_types: ["card"],
        metadata: request.metadata,
        payment_intent_data: {
          capture_method: "manual",
          metadata: request.metadata,
          description: request.title,
        },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: request.currency.toLowerCase(),
              unit_amount: request.holdCents,
              product_data: {
                name: request.title,
                description: request.description,
              },
            },
          },
        ],
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
      },
      { ...this.options, idempotencyKey: request.idempotencyKey },
    );
    if (!session.url) throw new Error("Stripe did not return a checkout URL.");
    return { id: session.id, url: session.url };
  }

  async getCheckout(id: string): Promise<CheckoutState | null> {
    try {
      const session = await this.stripe.checkout.sessions.retrieve(
        id,
        { expand: ["payment_intent"] },
        this.options,
      );
      const pi = session.payment_intent;
      return {
        id: session.id,
        status:
          session.status === "complete"
            ? "complete"
            : session.status === "expired"
              ? "expired"
              : "open",
        url: session.url,
        metadata: { ...(session.metadata ?? {}) },
        hold: pi && typeof pi !== "string" ? toHold(pi) : null,
      };
    } catch (error) {
      if (
        error instanceof Stripe.errors.StripeError &&
        error.code === "resource_missing"
      )
        return null;
      throw error;
    }
  }

  async expireCheckout(id: string, idempotencyKey: string) {
    await this.stripe.checkout.sessions.expire(
      id,
      {},
      { ...this.options, idempotencyKey },
    );
  }

  async setHoldMetadata(holdId: string, values: Record<string, string>) {
    await this.stripe.paymentIntents.update(
      holdId,
      { metadata: values },
      this.options,
    );
  }

  async capture(
    holdId: string,
    amountCents: number,
    applicationFeeCents: number,
    idempotencyKey: string,
  ) {
    const pi = await this.stripe.paymentIntents.capture(
      holdId,
      {
        amount_to_capture: amountCents,
        ...(this.chargesApplicationFee
          ? { application_fee_amount: applicationFeeCents }
          : {}),
      },
      { ...this.options, idempotencyKey },
    );
    return toHold(pi);
  }

  async release(holdId: string, idempotencyKey: string) {
    const pi = await this.stripe.paymentIntents.cancel(
      holdId,
      {},
      { ...this.options, idempotencyKey },
    );
    return toHold(pi);
  }

  /** Verifies Stripe's signature over the raw body. Throws on a bad signature. */
  static verifyWebhook(body: string, signature: string, secret: string) {
    return Stripe.webhooks.constructEvent(body, signature, secret);
  }
}
