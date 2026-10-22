/**
 * The shapes of the server's charging, payment and support API (see the server README,
 * "Driver API"), and the plain rules the screens use on them. Amounts are in minor
 * units of their currency (2500 EUR is €25.00), exactly as the server's payments say:
 * the app formats them and never computes what a driver pays.
 */
import type { LiveData } from "./live";

export type CommandStatus =
  | "claimed"
  | "sending"
  | "accepted"
  | "succeeded"
  | "failed"
  | "not_supported"
  | "timed_out"
  | "hold_failed";

export type CommandView = {
  id: string;
  type: "START_SESSION" | "STOP_SESSION";
  requestId: string;
  status: CommandStatus;
  /** True until the command ends: poll until it is false. */
  pending: boolean;
  /** The CPO's CommandResult (or CommandResponse) that ended it. */
  result: string | null;
  /** The server's words, in English; the app shows its own (startProblem). */
  message: string;
  peerMessage: string | null;
  /** Other ways to start at a charger that refuses app starts. */
  alternatives: "RFID"[];
  sessionId: string | null;
  createdAt: string;
  finishedAt: string | null;
};

/**
 * Why we stopped a session: `hold_increment_declined` when the card did not approve a
 * higher hold (never a charger fault), `other`, or null when we did not stop it.
 */
export type StopCode = "hold_increment_declined" | "other" | null;

export type PaymentStatus =
  "pending" | "held" | "failed" | "captured" | "released" | "expired";

export type PaymentView = {
  id: string;
  chargeId: string;
  status: PaymentStatus;
  currency: string;
  holdAmount: number;
  /** What the card covers now: the hold, raised where the card allowed it. */
  authorizedAmount: number;
  capturedAmount: number;
  refundedAmount: number;
  sessionCost: number | null;
  stopReason: string | null;
  stopCode: StopCode;
  underReview: boolean;
  demo: boolean;
  createdAt: string;
};

export type Place = { id: string; name: string; address: string; city: string };

export type SessionView = {
  id: string;
  status: string;
  open: boolean;
  kwh: number;
  startedAt: string;
  endedAt: string | null;
  currency: string;
  cost: { amount: number; vatIncluded: boolean } | null;
  stopCode: StopCode;
};

/** A charge in progress: the start, its payment and where. */
export type Charge = {
  command: CommandView;
  payment: PaymentView | null;
  place: Place | null;
};

export type SessionState = {
  session: SessionView | null;
  live: LiveData;
  payment: PaymentView | null;
  place: Place | null;
};

export type Card = {
  id: string;
  brand: string;
  last4: string;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
};

/** What PaymentSheet needs to save a card; demo mode gives none. */
export type CardSetup = {
  mode: "demo" | "live";
  customerId: string | null;
  setupIntentClientSecret: string | null;
  ephemeralKeySecret: string | null;
  publishableKey: string | null;
};

export type Quote = {
  currency: string;
  /** The hold before the start, or null when this network takes no app payments in it. */
  holdAmount: number | null;
  /** The hold may be raised during a long session, where the card allows it. */
  mayRaise: boolean;
  demo: boolean;
  hasCard: boolean;
};

export type HistoryItem = {
  chargeId: string;
  createdAt: string;
  status: CommandStatus;
  place: Place | null;
  evseUid: string | null;
  session: SessionView | null;
  payment: {
    status: PaymentStatus;
    currency: string;
    held: number;
    charged: number;
    refunded: number;
  };
  receipt: boolean;
  stopCode: StopCode;
};

export type Receipt = {
  chargeId: string;
  /** The app's location ID, to report a problem there. */
  locationId: string | null;
  paymentId: string;
  cdrId: string;
  place: {
    name: string | null;
    address: string;
    city: string;
    evseId: string;
    connector: string;
    powerType: string;
  };
  startedAt: string;
  endedAt: string;
  kwh: number;
  hours: number;
  currency: string;
  sessionCost: { amount: number; vatIncluded: boolean };
  held: number;
  charged: number;
  refunded: number;
  paymentStatus: PaymentStatus;
  shortfall: number | null;
  underReview: boolean;
  stopReason: string | null;
  stopCode: StopCode;
  demo: boolean;
};

export type Favourite = {
  locationId: string;
  createdAt: string;
  place: Place | null;
};

export const PROBLEM_CATEGORIES = [
  "not_starting",
  "stopped_early",
  "damaged",
  "blocked",
  "payment",
  "other",
] as const;
export type ProblemCategory = (typeof PROBLEM_CATEGORIES)[number];

export type ProblemReport = {
  locationId: string;
  evseUid?: string;
  category: ProblemCategory;
  message: string;
  /** A JPEG, base64, at most 1 MB. */
  photo?: string;
};

/** The live screen's phase, from the start and its session. */
export type Phase =
  "starting" | "charging" | "stopping" | "finished" | "failed";

export function phaseOf(
  charge: Pick<Charge, "command">,
  state: Pick<SessionState, "session"> | null,
  stopping: boolean,
): Phase {
  const c = charge.command;
  if (c.pending) return "starting";
  if (c.status !== "succeeded") return "failed";
  const s = state?.session;
  if (s && !s.open) return "finished";
  return stopping ? "stopping" : s ? "charging" : "starting";
}

/**
 * What went wrong with a start, as a key for the app's own words: the server's text is
 * English only. A refused card is never told as a charger fault, nor the other way.
 */
export type StartProblem =
  "card" | "notSupported" | "occupied" | "inoperative" | "timedOut" | "failed";

export function startProblem(c: CommandView): StartProblem | null {
  if (c.pending || c.status === "succeeded") return null;
  if (c.status === "hold_failed") return "card";
  if (c.status === "not_supported") return "notSupported";
  if (c.status === "timed_out" || c.result === "TIMEOUT") return "timedOut";
  if (c.result === "EVSE_OCCUPIED") return "occupied";
  if (c.result === "EVSE_INOPERATIVE") return "inoperative";
  return "failed";
}

/** Seconds since a moment, never negative. */
export const secondsSince = (iso: string, now = Date.now()) =>
  Math.max(0, (now - Date.parse(iso)) / 1000);

/** A new request ID for the server's one-command-per-request rule. */
export function requestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Older engines: 32 random hex digits, still unique enough per driver.
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return `app-${s}`;
}

/**
 * True when we cannot know whether the server acted: no answer (lost response,
 * dropped connection), a timeout, a rate limit or a server error (5xx), or an answer
 * we could not read. Only a clear refusal (any other 4xx) says nothing happened.
 */
export function outcomeUnknown(e: unknown): boolean {
  const code = (e as { name?: string; code?: unknown } | null)?.code;
  if (
    !(e instanceof Error) ||
    e.name !== "ApiError" ||
    typeof code !== "string"
  )
    return true;
  return (
    code === "unreachable" ||
    code === "rate_limited" ||
    code === "http_408" ||
    /^http_5\d\d$/.test(code)
  );
}

/**
 * One request ID per action (a start, a stop), kept until the server gives a
 * definitive answer. A retry after a lost response sends the same ID, so the server
 * replays the first command instead of placing a second hold or sending a second
 * START_SESSION. A new ID is made only after a refusal (4xx) or when `over` says the
 * command has ended without success, so the driver's next tap is a new attempt.
 */
export function oneRequest(make: () => string = requestId) {
  let id = make();
  return {
    get id() {
      return id;
    },
    async send<T>(
      fn: (id: string) => Promise<T>,
      over: (res: T) => boolean,
    ): Promise<T> {
      const used = id;
      try {
        const res = await fn(used);
        if (over(res) && id === used) id = make();
        return res;
      } catch (e) {
        if (!outcomeUnknown(e) && id === used) id = make();
        throw e;
      }
    },
  };
}
