import "server-only";

/**
 * creating: claimed; the bill, payment or start is not confirmed yet (the same form
 * repeats them with the same keys). open: paid, the driver was sent to Ivora Checkout
 * or the session runs; free, the start was sent (or may have been). settling: the
 * session ended, the bill is being finalized and captured. releasing: nothing will be
 * charged, the hold is being released. settled: the final bill was captured (free: the
 * session ended). released: the hold was released or never placed. failed: Ivora
 * refused before any hold. attention: settlement needs the operator.
 *
 * creating and open hold the connector: one such checkout per connector.
 */
export type CheckoutPhase =
  | "creating"
  | "open"
  | "settling"
  | "releasing"
  | "settled"
  | "released"
  | "failed"
  | "attention";

/** Phases that hold the connector. */
export const HOLDS_CONNECTOR: ReadonlySet<CheckoutPhase> = new Set([
  "creating",
  "open",
]);
/** Phases settlement still works on. */
export const UNSETTLED: ReadonlySet<CheckoutPhase> = new Set([
  "creating",
  "open",
  "settling",
  "releasing",
]);

/** The phases each phase may move to (the database enforces the same). */
export const NEXT_PHASES: Record<CheckoutPhase, readonly CheckoutPhase[]> = {
  creating: ["open", "failed", "releasing", "released"],
  open: ["settling", "releasing", "released", "settled", "attention"],
  releasing: ["open", "settling", "released", "settled", "attention"],
  settling: ["settled", "attention"],
  settled: [],
  released: [],
  failed: [],
  attention: [],
};

export type CheckoutKind = "paid" | "free";

/**
 * Why the operator should look at a checkout (shown in Live). stalled: the charger
 * reported nothing for STALLED_HOURS while Ivora still saw the session running (a lost
 * StopTransaction, say), so the kit stopped and settled it. hold_stop_ignored: the
 * charger kept charging after the hold stop and one retry.
 */
export type CheckoutAlert = "stalled" | "hold_stop_ignored";

/** The kit's own record of one "Pay and charge" or "Start free session". */
export interface CheckoutRecord {
  /** The source of every Idempotency-Key. Never sent to a browser or in a URL. */
  id: string;
  operatorId: string;
  /** The tap's random ID; also the driver's capability (their HTTP-only cookie). */
  requestId: string;
  /** The payment's return_reference (it ends up in Ivora's and Stripe's URLs). */
  reference: string;
  kind: CheckoutKind;
  stickerCode: string;
  stationId: number;
  connectorId: number;
  /** The Ivora tariff the bill snapshots. */
  tariffId: number;
  /**
   * The card hold, integer minor units of `currency`; 0 for free sessions. The tariff's
   * at the tap, then the bill's (the bill is the truth: settlement runs against it).
   */
  holdMinor: number;
  currency: string;
  phase: CheckoutPhase;
  billId: string | null;
  paymentId: string | null;
  checkoutUrl: string | null;
  startRequestedAt: string | null;
  startOperationId: string | null;
  transactionId: number | null;
  stopRequestedAt: string | null;
  /** When the kit sent the hold stop again because the charger ignored the first. */
  stopRetriedAt: string | null;
  /** The session's energy (Wh) when it last changed, and when that was. */
  meterWh: number | null;
  meterAt: string | null;
  alert: CheckoutAlert | null;
  /** The finalized bill and what was captured, integer minor units. */
  finalMinor: number | null;
  capturedMinor: number | null;
  error: string | null;
  checkedAt: string | null;
  settledAt: string | null;
  createdAt: string;
}

export type NewCheckout = Pick<
  CheckoutRecord,
  | "operatorId"
  | "requestId"
  | "kind"
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
  /** The bill's hold (only while the checkout is unsettled). */
  holdMinor?: number;
  paymentId?: string;
  checkoutUrl?: string;
  startOperationId?: string;
  transactionId?: number;
  finalMinor?: number;
  capturedMinor?: number;
  error?: string | null;
  /** The kit started the session itself (once). */
  startRequested?: true;
  /** The kit stopped the session near the hold (once). */
  stopRequested?: true;
  /** The kit sent the hold stop a second time (once). */
  stopRetried?: true;
  /** The session's energy now (null when not reported): meterAt moves when it changes. */
  meterWh?: number | null;
  alert?: CheckoutAlert;
  /** Settlement looked at it now. */
  checked?: true;
}

export type ClaimResult =
  | { id: string; created: boolean; busy?: undefined }
  /** Another checkout holds the connector (creating or open). Nothing was claimed. */
  | { busy: string; id?: undefined; created?: undefined };

/**
 * Where checkout records are kept: Supabase (service role; drivers are not staff) or,
 * in demo mode, the visitor's cookie.
 */
export interface CheckoutStore {
  readonly mode: "live" | "demo";
  /**
   * One checkout per tap and one per connector: the same request ID returns the record
   * it already made (created false); with a different sticker, connector, kind or tariff
   * it is refused (the hold is not compared: the bill's may have replaced the tariff's). While another checkout holds the connector, it is returned as busy
   * and nothing is claimed (also when two taps race).
   */
  claim(n: NewCheckout): Promise<ClaimResult>;
  get(operatorId: string, id: string): Promise<CheckoutRecord | null>;
  /** The checkout a tap made, by its request ID (the driver's cookie). */
  getByRequest(
    operatorId: string,
    requestId: string,
  ): Promise<CheckoutRecord | null>;
  /** By the payment's return_reference (the demo's stand-in pages). */
  getByReference(reference: string): Promise<CheckoutRecord | null>;
  /**
   * Checkouts settlement still works on, least recently checked first, across
   * operators (the server's sweep), or at one station (a webhook's cue).
   */
  listUnsettled(o: {
    stationId?: number;
    limit: number;
  }): Promise<CheckoutRecord[]>;
  /**
   * One operator's checkouts that need them, newest first: those in attention (made
   * in the last `days`), and unsettled ones with an alert.
   */
  listAlerts(
    operatorId: string,
    o: { days: number; limit: number },
  ): Promise<CheckoutRecord[]>;
  /**
   * IDs never change once recorded; phases only move along NEXT_PHASES. False when the
   * phase change was not applied.
   */
  record(
    operatorId: string,
    id: string,
    changes: CheckoutChanges,
  ): Promise<boolean>;
}

export type CheckoutErrorCode =
  | "not_found"
  | "not_in_service"
  | "private"
  | "free"
  | "not_free"
  | "no_price"
  | "offline"
  | "in_use"
  | "out_of_order"
  | "stripe_not_ready"
  | "free_not_ready"
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
