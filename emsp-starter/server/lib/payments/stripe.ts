import "server-only";
import { outboundFetch } from "@/lib/server/demo";

/**
 * The few Stripe API calls the eMSP makes, on the network's own Stripe account
 * (STRIPE_SECRET_KEY), as plain HTTPS requests through `outboundFetch`: demo mode can
 * never reach Stripe. No SDK, so nothing else in the server can call Stripe either.
 *
 * - Every write (POST) carries an `Idempotency-Key`, derived by the caller from the
 *   charge request (the START_SESSION command) and the action, so a retry, ours or a
 *   concurrent one, never holds, captures or refunds twice. Stripe keeps keys for at
 *   least 24 hours.
 * - A write whose outcome is unknown (a network error, a timeout, HTTP 409 for a key in
 *   use, 429 or 5xx) is retried once with the same key, then reported as
 *   StripeUnknownError: the caller tries again later with the same key.
 * - Errors carry Stripe's error type and code only, never the message or the request:
 *   they may name card details.
 */
export const STRIPE_API = "https://api.stripe.com";
/** The API version every request asks for, so response shapes never change under us. */
export const STRIPE_API_VERSION = "2025-09-30.clover";

export type Card = {
  brand?: string;
  last4?: string;
  exp_month?: number;
  exp_year?: number;
  /** Unix seconds: the last moment the hold can be captured. */
  capture_before?: number;
  incremental_authorization?: { status: "available" | "unavailable" };
};

export type Charge = {
  id: string;
  object: "charge";
  payment_intent: string | null;
  amount: number;
  amount_captured: number;
  amount_refunded: number;
  currency: string;
  payment_method_details?: { card?: Card } | null;
};

export type PaymentIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "requires_capture"
  | "canceled"
  | "succeeded";

export type PaymentIntent = {
  id: string;
  object: "payment_intent";
  status: PaymentIntentStatus;
  amount: number;
  amount_capturable: number;
  amount_received: number;
  currency: string;
  customer: string | null;
  payment_method: string | null;
  metadata: Record<string, string>;
  /** Expanded where we ask for it. */
  latest_charge: Charge | string | null;
  last_payment_error?: { code?: string; decline_code?: string } | null;
};

export type PaymentMethod = {
  id: string;
  object: "payment_method";
  type: string;
  customer: string | null;
  card?: Card;
};

export type Customer = {
  id: string;
  object: "customer";
  deleted?: boolean;
  metadata?: Record<string, string>;
};

export type SetupIntent = {
  id: string;
  object: "setup_intent";
  client_secret: string;
  customer: string | null;
  payment_method: string | null;
  status: string;
};

export type Refund = {
  id: string;
  object: "refund";
  amount: number;
  status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
  payment_intent: string | null;
};

export type EphemeralKey = { id: string; secret: string };

/** A Stripe answer we know the meaning of: a card refusal or a bad request. */
export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly code: string | undefined,
    readonly declineCode: string | undefined,
    /** For a refused PaymentIntent: its ID, when Stripe returned it. */
    readonly paymentIntentId?: string,
  ) {
    super(`Stripe answered ${status} ${type}${code ? ` (${code})` : ""}`);
    this.name = "StripeError";
  }
  get isCardError() {
    return this.type === "card_error";
  }
}

/** No answer, or one that says nothing about the outcome: retry with the same key. */
export class StripeUnknownError extends Error {
  constructor(what: string) {
    super(`Stripe request outcome unknown: ${what}`);
    this.name = "StripeUnknownError";
  }
}

type Params = Record<string, unknown>;

/** Stripe's form encoding: nested objects as a[b], arrays as a[0]. */
export function formEncode(params: Params): URLSearchParams {
  const out = new URLSearchParams();
  const add = (key: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => add(`${key}[${i}]`, x));
    else if (typeof v === "object")
      for (const [k, x] of Object.entries(v)) add(`${key}[${k}]`, x);
    else out.append(key, String(v));
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return out;
}

export type StripeOptions = {
  transport?: typeof outboundFetch;
  /** Delay before the one retry of an unknown outcome. Default 500 ms. */
  retryDelayMs?: number;
  timeoutMs?: number;
};

export type StripeApi = ReturnType<typeof stripeClient>;

const enc = encodeURIComponent;

export function stripeClient(secretKey: string, options: StripeOptions = {}) {
  const transport = options.transport ?? outboundFetch;
  const retryDelayMs = options.retryDelayMs ?? 500;

  async function once<T>(
    method: "GET" | "POST",
    path: string,
    params: Params | undefined,
    headers: Record<string, string>,
  ): Promise<T> {
    const what = `${method} ${path.split("?")[0].replace(/\/(pi|cus|pm|seti|re|ch)_[^/]+/g, "/$1_…")}`;
    const body = params ? formEncode(params) : undefined;
    const url =
      method === "GET" && body?.size
        ? `${STRIPE_API}${path}?${body}`
        : `${STRIPE_API}${path}`;
    let res: Response;
    try {
      res = await transport(url, {
        method,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Stripe-Version": STRIPE_API_VERSION,
          ...(method === "POST"
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
          ...headers,
        },
        body: method === "POST" ? (body?.toString() ?? "") : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      });
    } catch (e) {
      // Demo mode refuses before anything is sent: that is not an unknown outcome.
      if (e instanceof Error && "code" in e && e.code === "demo_mode") throw e;
      throw new StripeUnknownError(`${what}: no answer`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    if (res.ok && json && typeof json === "object") return json as T;
    if (
      res.status === 409 ||
      res.status === 429 ||
      res.status >= 500 ||
      (!res.ok && json === undefined)
    )
      throw new StripeUnknownError(`${what}: HTTP ${res.status}`);
    if (res.ok) throw new StripeUnknownError(`${what}: unreadable answer`);
    const err = (json as { error?: Record<string, unknown> }).error ?? {};
    const pi = err.payment_intent as { id?: unknown } | undefined;
    throw new StripeError(
      res.status,
      typeof err.type === "string" ? err.type : "api_error",
      typeof err.code === "string" ? err.code : undefined,
      typeof err.decline_code === "string" ? err.decline_code : undefined,
      typeof pi?.id === "string" ? pi.id : undefined,
    );
  }

  /** A request; a write carries its idempotency key and is retried once if unknown. */
  async function request<T>(
    method: "GET" | "POST",
    path: string,
    params?: Params,
    {
      idempotencyKey,
      stripeVersion,
    }: { idempotencyKey?: string; stripeVersion?: string } = {},
  ): Promise<T> {
    if (method === "POST" && !idempotencyKey)
      throw new Error("Every Stripe write needs an idempotency key");
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    if (stripeVersion) headers["Stripe-Version"] = stripeVersion;
    try {
      return await once<T>(method, path, params, headers);
    } catch (e) {
      if (!(e instanceof StripeUnknownError)) throw e;
      if (retryDelayMs) await new Promise((r) => setTimeout(r, retryDelayMs));
      return once<T>(method, path, params, headers);
    }
  }

  return {
    createCustomer: (
      p: { email: string; driverRef: string },
      idempotencyKey: string,
    ) =>
      request<Customer>(
        "POST",
        "/v1/customers",
        { email: p.email, metadata: { driver_ref: p.driverRef } },
        { idempotencyKey },
      ),
    setDefaultPaymentMethod: (
      customer: string,
      paymentMethod: string,
      idempotencyKey: string,
    ) =>
      request<Customer>(
        "POST",
        `/v1/customers/${enc(customer)}`,
        { invoice_settings: { default_payment_method: paymentMethod } },
        { idempotencyKey },
      ),
    createSetupIntent: (customer: string, idempotencyKey: string) =>
      request<SetupIntent>(
        "POST",
        "/v1/setup_intents",
        {
          customer,
          usage: "off_session",
          payment_method_types: ["card"],
        },
        { idempotencyKey },
      ),
    /** For the app's PaymentSheet: `stripeVersion` is the app SDK's API version. */
    createEphemeralKey: (
      customer: string,
      stripeVersion: string,
      idempotencyKey: string,
    ) =>
      request<EphemeralKey>(
        "POST",
        "/v1/ephemeral_keys",
        { customer },
        { idempotencyKey, stripeVersion },
      ),
    listCards: (customer: string) =>
      request<{ data: PaymentMethod[] }>(
        "GET",
        `/v1/customers/${enc(customer)}/payment_methods`,
        { type: "card", limit: 20 },
      ).then((r) => r.data),
    getPaymentMethod: (id: string) =>
      request<PaymentMethod>("GET", `/v1/payment_methods/${enc(id)}`),
    detachPaymentMethod: (id: string, idempotencyKey: string) =>
      request<PaymentMethod>(
        "POST",
        `/v1/payment_methods/${enc(id)}/detach`,
        {},
        { idempotencyKey },
      ),
    /**
     * A hold: a manual-capture PaymentIntent, confirmed off-session on the saved card.
     * `incremental` asks for incremental authorization where the card allows it.
     */
    createHold: (
      p: {
        amount: number;
        currency: string;
        customer: string;
        paymentMethod: string;
        metadata: Record<string, string>;
        incremental: boolean;
        description: string;
      },
      idempotencyKey: string,
    ) =>
      request<PaymentIntent>(
        "POST",
        "/v1/payment_intents",
        {
          amount: p.amount,
          currency: p.currency.toLowerCase(),
          customer: p.customer,
          payment_method: p.paymentMethod,
          capture_method: "manual",
          confirm: true,
          off_session: true,
          description: p.description,
          metadata: p.metadata,
          expand: ["latest_charge"],
          ...(p.incremental
            ? {
                payment_method_options: {
                  card: { request_incremental_authorization: "if_available" },
                },
              }
            : {}),
        },
        { idempotencyKey },
      ),
    getPaymentIntent: (id: string) =>
      request<PaymentIntent>("GET", `/v1/payment_intents/${enc(id)}`, {
        expand: ["latest_charge"],
      }),
    capture: (id: string, amountToCapture: number, idempotencyKey: string) =>
      request<PaymentIntent>(
        "POST",
        `/v1/payment_intents/${enc(id)}/capture`,
        { amount_to_capture: amountToCapture, expand: ["latest_charge"] },
        { idempotencyKey },
      ),
    cancel: (id: string, idempotencyKey: string) =>
      request<PaymentIntent>(
        "POST",
        `/v1/payment_intents/${enc(id)}/cancel`,
        {},
        { idempotencyKey },
      ),
    /** Raises the hold to `amount`, the new total. */
    incrementAuthorization: (
      id: string,
      amount: number,
      idempotencyKey: string,
    ) =>
      request<PaymentIntent>(
        "POST",
        `/v1/payment_intents/${enc(id)}/increment_authorization`,
        { amount, expand: ["latest_charge"] },
        { idempotencyKey },
      ),
    refund: (
      p: {
        paymentIntent: string;
        amount: number;
        metadata: Record<string, string>;
      },
      idempotencyKey: string,
    ) =>
      request<Refund>(
        "POST",
        "/v1/refunds",
        {
          payment_intent: p.paymentIntent,
          amount: p.amount,
          metadata: p.metadata,
        },
        { idempotencyKey },
      ),
  };
}

/** The charge of a PaymentIntent, when it was expanded. */
export const chargeOf = (pi: PaymentIntent): Charge | null =>
  pi.latest_charge && typeof pi.latest_charge === "object"
    ? pi.latest_charge
    : null;
