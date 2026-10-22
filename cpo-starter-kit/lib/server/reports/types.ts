import "server-only";
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

/** The sessions table's status filter. */
export const STATUS_FILTERS = [
  "all",
  "charging",
  "ended",
  "billed",
  "unbilled",
] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  all: "All sessions",
  charging: "Charging now",
  ended: "Ended",
  billed: "Ended, final bill",
  unbilled: "Ended, no final bill",
};

/**
 * What a session was, from how it started: a driver who paid (it settles a bill), a
 * free session (the operator's free charging token), a staff/test session (the staff
 * token: Live's remote start and the charger test) or anything else (an RFID card, a
 * roaming partner). Only driver sessions carry revenue.
 */
export type SessionKind = "driver" | "free" | "staff" | "other";

export const SESSION_KIND_LABELS: Record<SessionKind, string> = {
  driver: "Driver (paid)",
  free: "Free",
  staff: "Staff/test",
  other: "Other",
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
}

/** One row of the sessions table and the CSV export. */
export interface SessionRow {
  /** Ivora's transaction resource ID. */
  id: number;
  stationId: number | null;
  stationName: string;
  siteName: string | null;
  /** The site's time zone, else the report's. */
  timeZone: string;
  connectorId: number | null;
  connectorNumber: number | null;
  /** UTC, ISO 8601. */
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  energyWh: number | null;
  kind: SessionKind;
  status: "charging" | "ended";
  stopReason: string | null;
  billId: string | null;
  billStatus: "open" | "final" | null;
  /** The final bill's total in integer minor units; null until final. */
  amountMinor: number | null;
  currency: string | null;
}
