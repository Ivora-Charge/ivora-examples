import "server-only";

/**
 * creating: claimed; the bill or the hosted payment is not confirmed yet (the same form
 * repeats them with the same keys). checkout: the driver was sent to Ivora Checkout.
 * failed: Ivora refused; nothing was charged.
 */
export type CheckoutPhase = "creating" | "checkout" | "failed";

/** The kit's own record of one "Pay and charge". Its ID is the session reference. */
export interface CheckoutRecord {
  id: string;
  operatorId: string;
  requestId: string;
  stickerCode: string;
  stationId: number;
  connectorId: number;
  /** The Ivora tariff the bill snapshots. */
  tariffId: number;
  /** Integer minor units of `currency`. */
  holdMinor: number;
  currency: string;
  phase: CheckoutPhase;
  billId: string | null;
  paymentId: string | null;
  checkoutUrl: string | null;
  startRequestedAt: string | null;
  error: string | null;
  createdAt: string;
}

export type NewCheckout = Pick<
  CheckoutRecord,
  | "operatorId"
  | "requestId"
  | "stickerCode"
  | "stationId"
  | "connectorId"
  | "tariffId"
  | "holdMinor"
  | "currency"
>;

export interface CheckoutChanges {
  phase?: CheckoutPhase;
  billId?: string;
  paymentId?: string;
  checkoutUrl?: string;
  error?: string | null;
  /** The kit started the bill itself (once). */
  startRequested?: true;
}

/**
 * Where checkout records are kept: Supabase (service role; drivers are not staff) or,
 * in demo mode, the visitor's cookie.
 */
export interface CheckoutStore {
  readonly mode: "live" | "demo";
  /**
   * One checkout per tap: the same request ID returns the record it already made
   * (created false); with a different sticker, connector or price it is refused.
   */
  claim(n: NewCheckout): Promise<{ id: string; created: boolean }>;
  get(operatorId: string, id: string): Promise<CheckoutRecord | null>;
  /** A bill or payment ID never changes once recorded; a phase never goes back. */
  record(
    operatorId: string,
    id: string,
    changes: CheckoutChanges,
  ): Promise<void>;
}

export type CheckoutErrorCode =
  | "not_found"
  | "not_in_service"
  | "private"
  | "free"
  | "no_price"
  | "offline"
  | "in_use"
  | "out_of_order"
  | "stripe_not_ready"
  | "expired"
  | "rate_limited"
  | "invalid"
  | "refused"
  | "unconfirmed"
  | "unavailable";

/**
 * An error a driver can read: what happened and what to do next. `apiCode` and
 * `requestId` are Ivora's, shown small for support; never keys or personal data.
 */
export class CheckoutError extends Error {
  constructor(
    public code: CheckoutErrorCode,
    message: string,
    public apiCode?: string,
    public requestId?: string,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}
