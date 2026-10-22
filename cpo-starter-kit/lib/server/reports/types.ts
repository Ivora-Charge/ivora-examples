import "server-only";
import type {
  CheckoutAlert,
  CheckoutKind,
  CheckoutPhase,
} from "../checkout/types";
import type { StatsBucketSize } from "../ivora/types";

/** The periods the form offers; "custom" takes dates and a bucket. */
export const PRESETS = ["24h", "7d", "30d", "90d", "12m", "custom"] as const;
export type Preset = (typeof PRESETS)[number];

export const PRESET_LABELS: Record<Preset, string> = {
  "24h": "Last 24 hours, by hour",
  "7d": "Last 7 days, by day",
  "30d": "Last 30 days, by day",
  "90d": "Last 90 days, by day",
  "12m": "Last 12 months, by month",
  custom: "Custom dates",
};

/**
 * A checkout's status in reports (the database's cpo_report_status says the same):
 * in_progress while settlement still works on it, charged for a paid session that
 * captured money (also one that needed the operator until Ivora's staff captured its
 * hold), attention when it needs the operator, no_charge otherwise (released, failed,
 * free, or nothing captured).
 */
export type ReportStatus =
  "in_progress" | "charged" | "no_charge" | "attention";

export const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  in_progress: "In progress",
  charged: "Charged",
  no_charge: "Nothing charged",
  attention: "Needs you",
};

/** The sessions table's status filter: a status, or refunded (any refund). */
export const STATUS_FILTERS = [
  "all",
  "in_progress",
  "charged",
  "refunded",
  "no_charge",
  "attention",
] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  all: "All sessions",
  in_progress: "In progress",
  charged: "Charged",
  refunded: "Refunded",
  no_charge: "Nothing charged",
  attention: "Needs you",
};

export const SESSION_KIND_LABELS: Record<CheckoutKind, string> = {
  paid: "Driver (paid)",
  free: "Free",
};

/** The page's filters, parsed and checked. Times are UTC instants (ms). */
export interface ReportQuery {
  preset: Preset;
  bucket: StatsBucketSize;
  /** The report's IANA time zone (bucket boundaries, dates in the form). */
  timeZone: string;
  /** Start (inclusive) and end (exclusive), whole buckets. */
  fromMs: number;
  toMs: number;
  /** The same period as local dates, for the form (toDate inclusive). */
  fromDate: string;
  toDate: string;
  stationId: number | null;
  status: StatusFilter;
  /** The sessions table's page, from 1. */
  page: number;
}

/** What the kit's records are filtered by: one operator, made in [fromMs, toMs). */
export interface ReportFilter {
  operatorId: string;
  fromMs: number;
  toMs: number;
  stationId: number | null;
  status: StatusFilter;
}

/**
 * One of the kit's checkouts as reports read it: the driver's tap (paid or free), what
 * settlement recorded (the bill, what was captured), what the sweep copied from Ivora
 * (the session's details, refunds). Integer minor units of `currency`.
 */
export interface ReportCheckout {
  /** The kit's record ID: server only (the export's paging), never shown or sent. */
  id: string;
  /** The checkout's reference (ck_…), shown as the session's ID. */
  reference: string;
  kind: CheckoutKind;
  stationId: number;
  connectorId: number;
  phase: CheckoutPhase;
  alert: CheckoutAlert | null;
  /** When the driver tapped (UTC, ISO 8601): reports put the session in this period. */
  createdAt: string;
  /**
   * The same time exactly as the database holds it (microseconds), with `id` the
   * export's keyset cursor. createdAt is cut to milliseconds, so paging on it would
   * skip rows made in the same millisecond as a page's last one.
   */
  cursor: string;
  settledAt: string | null;
  transactionId: number | null;
  billId: string | null;
  holdMinor: number;
  currency: string;
  /** The final bill's total, once settlement finalized it. */
  finalMinor: number | null;
  /** What was captured: 0 when the hold was released (a bill under Stripe's minimum). */
  capturedMinor: number | null;
  /** Refunded of the captured amount, as the payment last said. */
  refundedMinor: number | null;
  refundCheckedAt: string | null;
  /** The session's energy so far while it runs (settlement's last reading). */
  meterWh: number | null;
  /** From GET /transactions/{id} once the session ended; null until then. */
  sessionStartedAt: string | null;
  sessionEndedAt: string | null;
  energyWh: number | null;
  connectorNumber: number | null;
  stopReason: string | null;
  detailAt: string | null;
}

/** One currency's money from paid sessions: billed, captured and refunded. */
export interface CurrencyTotals {
  currency: string;
  /** Paid sessions that captured money. */
  charged: number;
  billedMinor: number;
  capturedMinor: number;
  refundedMinor: number;
}

/** The totals of the checkouts that match a filter (cpo_report_totals). */
export interface ReportTotals {
  checkouts: number;
  paid: number;
  free: number;
  /** Checkouts with a charging session (a transaction). */
  withSession: number;
  byStatus: Record<ReportStatus, number>;
  /** Of the sessions whose details are recorded. */
  energyWh: number;
  /** Sessions whose details the sweep has not copied yet. */
  detailsPending: number;
  /** Charged sessions whose payment the sweep has not read for refunds yet. */
  refundsUnchecked: number;
  currencies: CurrencyTotals[];
}

/** A session's details from GET /transactions/{id}. */
export interface SessionDetails {
  startedAt: string | null;
  /** Null while the session runs: then nothing is recorded. */
  endedAt: string | null;
  energyWh: number | null;
  connectorNumber: number | null;
  stopReason: string | null;
}

/** Work for the sweep: one checkout and the Ivora resource to read. */
export interface DueDetails {
  operatorId: string;
  id: string;
  transactionId: number;
}
export interface DuePayment {
  operatorId: string;
  id: string;
  paymentId: string;
}

/** The export's keyset: the last row's full created_at and its ID. */
export interface ReportCursor {
  at: string;
  id: string;
}

/**
 * Where reports read the kit's checkouts: Supabase (service role, through the
 * cpo_report_* functions) or, in demo mode, sample history and the visitor's cookie.
 */
export interface ReportsStore {
  readonly mode: "live" | "demo";
  /**
   * Newest first. `offset` pages the Reports page; `after` (a row's `cursor` and id,
   * a keyset on the full database timestamp) pages the export, which new checkouts
   * can't shift. At most 500.
   */
  list(
    f: ReportFilter,
    page: {
      limit: number;
      offset?: number;
      after?: ReportCursor;
    },
  ): Promise<ReportCheckout[]>;
  totals(f: ReportFilter): Promise<ReportTotals>;
  /** Ended sessions whose details are not recorded (settled in the last 30 days). */
  detailsDue(limit: number): Promise<DueDetails[]>;
  /** Keeps an ended session's details once; notes the check either way. */
  recordDetails(
    operatorId: string,
    id: string,
    d: SessionDetails,
  ): Promise<boolean>;
  /**
   * Payments not read for a day (settled in the last 90 days): charged ones, for
   * refunds, and paid checkouts that need you (for example a bill above its hold),
   * in case Ivora's staff captured the hold since.
   */
  paymentsDue(limit: number): Promise<DuePayment[]>;
  /**
   * What the payment says. A capture is kept only for a checkout that needs you and
   * has none recorded, capped at its hold; the refund is capped at what was captured.
   */
  recordPayment(
    operatorId: string,
    id: string,
    p: { capturedMinor: number; refundedMinor: number },
  ): Promise<boolean>;
}

/** One row of the sessions table and the CSV export. */
export interface SessionRow {
  reference: string;
  kind: CheckoutKind;
  status: ReportStatus;
  phase: CheckoutPhase;
  stationId: number;
  stationName: string;
  siteName: string | null;
  /** The site's time zone, else the report's. */
  timeZone: string;
  connectorId: number;
  connectorNumber: number | null;
  /** UTC, ISO 8601: the tap, and the session's start and end once recorded. */
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  /** Recorded once the session ended. */
  energyWh: number | null;
  /** While in progress: settlement's last reading. */
  energySoFarWh: number | null;
  stopReason: string | null;
  transactionId: number | null;
  billId: string | null;
  currency: string;
  holdMinor: number | null;
  billedMinor: number | null;
  capturedMinor: number | null;
  refundedMinor: number | null;
  /** Captured minus refunded. */
  netMinor: number | null;
  refundCheckedAt: string | null;
  detailsPending: boolean;
}
