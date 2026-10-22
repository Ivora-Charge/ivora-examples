import "server-only";
import { whToKwhText } from "../../units";
import {
  describeError,
  ERRORS_URL,
  IvoraError,
  type IvoraClient,
  type Location,
  type Station,
  type Stats,
  type StatsBucketSize,
  type TransactionDetail,
} from "../ivora";
import type { OnboardingStore } from "../onboarding/types";
import type { Staff } from "../team/types";
import { reportStatus } from "./records";
import {
  bucketCeil,
  bucketFloor,
  isoInZone,
  isTimeZone,
  localDate,
  MAX_BUCKETS,
  MAX_STATS_SESSIONS,
  nextDate,
  zonedToUtc,
} from "./time";
import {
  PRESETS,
  STATUS_FILTERS,
  type Preset,
  type ReportCheckout,
  type ReportCursor,
  type ReportFilter,
  type ReportQuery,
  type ReportsStore,
  type ReportTotals,
  type SessionDetails,
  type SessionRow,
  type StatusFilter,
} from "./types";

const HOUR_MS = 3_600_000;

/**
 * What reports read. Period figures for every session on the operator's chargers come
 * from Ivora's GET /stats. Session rows, their totals and driver revenue come from the
 * kit's own checkout records (`store`): Ivora's transaction list has no date filter,
 * so the kit never scans it.
 */
export interface ReportsDeps {
  ivora: IvoraClient;
  company: Pick<OnboardingStore, "load">;
  store: ReportsStore;
  now: () => number;
}

/** Rows per page of the sessions table. */
export const PAGE_ROWS = 50;

// ---- Period and filters ----

type Params = { get(name: string): string | null };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BUCKETS: StatsBucketSize[] = ["hour", "day", "month"];

function validDate(s: string | null): s is string {
  if (!s || !DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** `date` plus `days` days (YYYY-MM-DD). */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** The first of `date`'s month plus `months` months (YYYY-MM-01). */
function addMonths(date: string, months: number): string {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 10);
}

const midnight = (date: string, zone: string) =>
  zonedToUtc(date, "00:00", zone).getTime();

/**
 * The page's filters from the URL. Presets stay within Ivora's stats limits; a custom
 * period may not (Ivora then answers stats_range_too_large, shown as such). Anything
 * unreadable falls back to the last 30 days, with a message.
 */
export function parseReportQuery(
  params: Params,
  timeZone: string,
  now: number,
): { query: ReportQuery; error: string | null } {
  let error: string | null = null;
  let preset = (params.get("period") ?? "30d") as Preset;
  if (!PRESETS.includes(preset)) {
    error = "Unknown period: showing the last 30 days.";
    preset = "30d";
  }
  const today = localDate(timeZone, now);
  let bucket: StatsBucketSize = "day";
  let fromMs: number;
  let toMs: number;
  if (preset === "custom") {
    const from = params.get("from");
    const to = params.get("to");
    const b = params.get("bucket") as StatsBucketSize | null;
    if (!validDate(from) || !validDate(to)) {
      error = "Enter both dates (YYYY-MM-DD): showing the last 30 days.";
      preset = "30d";
    } else if (from > to) {
      error = "The start date is after the end date: showing the last 30 days.";
      preset = "30d";
    } else {
      bucket = b && BUCKETS.includes(b) ? b : "day";
      fromMs = bucketFloor(midnight(from, timeZone), bucket, timeZone);
      toMs = bucketCeil(midnight(nextDate(to), timeZone), bucket, timeZone);
    }
  }
  if (preset === "24h") {
    bucket = "hour";
    toMs = bucketFloor(now, "hour", timeZone) + HOUR_MS;
    fromMs = toMs - 24 * HOUR_MS;
  } else if (preset === "12m") {
    bucket = "month";
    fromMs = midnight(addMonths(today, -11), timeZone);
    toMs = midnight(addMonths(today, 1), timeZone);
  } else if (preset !== "custom") {
    const days = { "7d": 7, "30d": 30, "90d": 90 }[preset];
    bucket = "day";
    fromMs = midnight(addDays(today, 1 - days), timeZone);
    toMs = midnight(nextDate(today), timeZone);
  }
  const station = params.get("station");
  let status = (params.get("status") ?? "all") as StatusFilter;
  if (!STATUS_FILTERS.includes(status)) status = "all";
  const page = params.get("page");
  return {
    query: {
      preset,
      bucket,
      timeZone,
      fromMs: fromMs!,
      toMs: toMs!,
      fromDate: localDate(timeZone, fromMs!),
      toDate: localDate(timeZone, toMs! - 1),
      stationId:
        station && /^[1-9]\d{0,11}$/.test(station) ? Number(station) : null,
      status,
      page: page && /^[1-9]\d{0,5}$/.test(page) ? Number(page) : 1,
    },
    error,
  };
}

/**
 * The query as URL parameters: the same period and filters, for the CSV link (without
 * a page) and the table's pages.
 */
export function reportSearch(q: ReportQuery, page?: number): string {
  const p = new URLSearchParams({ period: q.preset });
  if (q.preset === "custom") {
    p.set("from", q.fromDate);
    p.set("to", q.toDate);
    p.set("bucket", q.bucket);
  }
  if (q.stationId !== null) p.set("station", String(q.stationId));
  if (q.status !== "all") p.set("status", q.status);
  if (page !== undefined && page > 1) p.set("page", String(page));
  return p.toString();
}

/**
 * The report's time zone: the company's (Settings), else the one every site with a
 * time zone shares, else UTC. Each session row also shows its own site's local time.
 */
export function reportTimeZone(
  companyZone: string | null,
  locations: Location[],
): { zone: string; source: "company" | "sites" | "utc" } {
  if (companyZone && isTimeZone(companyZone))
    return { zone: companyZone, source: "company" };
  const zones = new Set(
    locations
      .map((l) => l.time_zone)
      .filter((z): z is string => typeof z === "string" && isTimeZone(z)),
  );
  if (zones.size === 1) return { zone: [...zones][0], source: "sites" };
  return { zone: "UTC", source: "utc" };
}

// ---- Statistics ----

export type StatsResult =
  { ok: true; stats: Stats } | { ok: false; tooLarge: boolean; error: string };

function logFailure(what: string, e: unknown) {
  // Code and request ID only: never the key, tenant ID or response body.
  console.error(
    `cpo-starter-kit: reports ${what} failed:`,
    e instanceof IvoraError
      ? `${e.code} (HTTP ${e.status}) ${e.requestId ?? ""}`
      : e instanceof Error
        ? e.name
        : "error",
  );
}

/** What to show for 422 stats_range_too_large: the limits and what to pick instead. */
export function rangeTooLargeMessage(q: ReportQuery, e: IvoraError): string {
  const max = MAX_BUCKETS[q.bucket];
  const hint =
    q.bucket === "hour"
      ? "By hour covers up to 7 days: pick a shorter period, or show it by day."
      : q.bucket === "day"
        ? "By day covers up to 92 days: pick a shorter period, or show it by month."
        : "By month covers up to 24 months: pick a shorter period.";
  const req = e.requestId ? ` Request ${e.requestId}.` : "";
  return `This period is too large for one report (stats_range_too_large): Ivora returns at most ${max} ${q.bucket} buckets, and at most ${MAX_STATS_SESSIONS.toLocaleString("en-US")} sessions per report. ${hint}${req} See ${ERRORS_URL}`;
}

/** `GET /stats` for the period, in the report's time zone, with the top 5 stations. */
export async function loadStats(
  ivora: IvoraClient,
  q: ReportQuery,
): Promise<StatsResult> {
  try {
    const stats = await ivora.getStats({
      from: new Date(q.fromMs).toISOString(),
      to: new Date(q.toMs).toISOString(),
      bucket: q.bucket,
      time_zone: q.timeZone,
      top: 5,
    });
    return { ok: true, stats };
  } catch (e) {
    logFailure("stats", e);
    if (e instanceof IvoraError && e.code === "stats_range_too_large")
      return { ok: false, tooLarge: true, error: rangeTooLargeMessage(q, e) };
    return { ok: false, tooLarge: false, error: describeError(e) };
  }
}

// ---- Sessions (the kit's own checkouts) ----

/** Stations and sites by ID: names and time zones for the rows. */
export interface StationContext {
  stations: Map<
    number,
    { name: string; siteName: string | null; timeZone: string | null }
  >;
  /** The report's time zone, for sessions whose site has none. */
  timeZone: string;
}

export function stationContext(
  stations: Station[],
  locations: Location[],
  timeZone: string,
): StationContext {
  const sites = new Map(locations.map((l) => [l.id, l]));
  return {
    stations: new Map(
      stations.map((s) => {
        const site = s.location_id ? sites.get(s.location_id) : undefined;
        const zone = site?.time_zone;
        return [
          s.id,
          {
            name: s.name,
            siteName: site?.name ?? null,
            timeZone: zone && isTimeZone(zone) ? zone : null,
          },
        ];
      }),
    ),
    timeZone,
  };
}

/** What the kit's records are filtered by, for the signed-in operator. */
export const reportFilter = (staff: Staff, q: ReportQuery): ReportFilter => ({
  operatorId: staff.operatorId,
  fromMs: q.fromMs,
  toMs: q.toMs,
  stationId: q.stationId,
  status: q.status,
});

const safeInt = (v: number | null | undefined) =>
  typeof v === "number" && Number.isSafeInteger(v) ? v : null;

/**
 * One row from a checkout. Money is the paid session's: the hold, the final bill
 * (billed), what was captured, what was refunded and the net (captured minus
 * refunded). Free sessions carry none.
 */
export function toRow(c: ReportCheckout, ctx: StationContext): SessionRow {
  const st = ctx.stations.get(c.stationId);
  const start = c.sessionStartedAt ? Date.parse(c.sessionStartedAt) : NaN;
  const end = c.sessionEndedAt ? Date.parse(c.sessionEndedAt) : NaN;
  const status = reportStatus(c);
  const paid = c.kind === "paid";
  const captured = paid ? safeInt(c.capturedMinor) : null;
  const refunded = paid ? safeInt(c.refundedMinor) : null;
  return {
    reference: c.reference,
    kind: c.kind,
    status,
    phase: c.phase,
    stationId: c.stationId,
    stationName: st?.name ?? `Charger ${c.stationId}`,
    siteName: st?.siteName ?? null,
    timeZone: st?.timeZone ?? ctx.timeZone,
    connectorId: c.connectorId,
    connectorNumber: c.connectorNumber,
    createdAt: c.createdAt,
    startedAt: Number.isNaN(start) ? null : new Date(start).toISOString(),
    endedAt: Number.isNaN(end) ? null : new Date(end).toISOString(),
    durationSeconds:
      Number.isNaN(start) || Number.isNaN(end)
        ? null
        : Math.max(0, Math.round((end - start) / 1000)),
    energyWh: c.detailAt ? safeInt(c.energyWh) : null,
    energySoFarWh: status === "in_progress" ? safeInt(c.meterWh) : null,
    stopReason: c.stopReason,
    transactionId: c.transactionId,
    billId: c.billId,
    currency: c.currency,
    holdMinor: paid ? c.holdMinor : null,
    billedMinor: paid ? safeInt(c.finalMinor) : null,
    capturedMinor: captured,
    refundedMinor: refunded,
    netMinor: captured === null ? null : captured - (refunded ?? 0),
    refundCheckedAt: paid ? c.refundCheckedAt : null,
    detailsPending: c.transactionId !== null && c.detailAt === null,
  };
}

export type SessionsResult =
  | {
      ok: true;
      /** This page's rows, newest first. */
      rows: SessionRow[];
      totals: ReportTotals;
      page: number;
      pages: number;
    }
  | { ok: false; error: string };

/** The table's page and the totals of every checkout that matches the filters. */
export async function loadSessions(
  d: Pick<ReportsDeps, "store">,
  f: ReportFilter,
  page: number,
  ctx: StationContext,
): Promise<SessionsResult> {
  try {
    const totals = await d.store.totals(f);
    const pages = Math.max(1, Math.ceil(totals.checkouts / PAGE_ROWS));
    const at = Math.min(page, pages);
    const rows = await d.store.list(f, {
      limit: PAGE_ROWS,
      offset: (at - 1) * PAGE_ROWS,
    });
    return {
      ok: true,
      rows: rows.map((c) => toRow(c, ctx)),
      totals,
      page: at,
      pages,
    };
  } catch (e) {
    logFailure("sessions", e);
    return { ok: false, error: describeError(e) };
  }
}

// ---- The whole page ----

export interface ReportsContext {
  mode: "live" | "demo";
  query: ReportQuery;
  /** A filter that could not be read (the page then shows the default period). */
  queryError: string | null;
  timeZoneSource: "company" | "sites" | "utc";
  stations: { id: number; name: string }[];
  /** More stations or sites than the client pages through. */
  truncated: boolean;
  places: StationContext;
}

/**
 * What the page and the export need before reading sessions: the time zone, the
 * period and the stations (names, sites, the station filter).
 */
export async function loadReportsContext(
  d: ReportsDeps,
  staff: Staff,
  params: Params,
): Promise<
  { ok: true; context: ReportsContext } | { ok: false; error: string }
> {
  try {
    const [profile, stations, locations] = await Promise.all([
      d.company.load(staff.operatorId).catch(() => null),
      d.ivora.listAllStations(),
      d.ivora.listAllLocations(),
    ]);
    const tz = reportTimeZone(profile?.timeZone ?? null, locations.data);
    const { query, error } = parseReportQuery(params, tz.zone, d.now());
    return {
      ok: true,
      context: {
        mode: d.ivora.mode,
        query,
        queryError: error,
        timeZoneSource: tz.source,
        stations: stations.data
          .map((s) => ({ id: s.id, name: s.name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        truncated: stations.truncated || locations.truncated,
        places: stationContext(stations.data, locations.data, tz.zone),
      },
    };
  } catch (e) {
    logFailure("context", e);
    return { ok: false, error: describeError(e) };
  }
}

// ---- CSV export ----

/**
 * The export's columns, in this order, in every file (README: Reports). Times are
 * UTC, then the site's local time with its offset; energy in Wh and exact kWh; money
 * in integer minor units with the ISO 4217 currency.
 */
export const CSV_COLUMNS = [
  "session_ref",
  "session_type",
  "status",
  "created_at_utc",
  "started_at_utc",
  "ended_at_utc",
  "time_zone",
  "started_at_local",
  "ended_at_local",
  "duration_seconds",
  "site",
  "station_id",
  "station",
  "connector_id",
  "connector_number",
  "energy_wh",
  "energy_kwh",
  "stop_reason",
  "transaction_id",
  "bill_id",
  "currency",
  "hold_minor",
  "billed_minor",
  "captured_minor",
  "refunded_minor",
  "net_minor",
  "refunds_checked_at_utc",
  "details",
] as const;

/** Rows in one file: more is refused (422) before anything is sent. */
export const CSV_MAX_ROWS = 10_000;
/** Rows read from the database at a time. */
const CSV_PAGE = 500;
/**
 * The export's budget, counted from the request's start (the site and charger reads
 * before it can take 20 s with 429 waits): past it the download fails, well inside the
 * route's maxDuration of 60 seconds.
 */
export const CSV_SECONDS = 45;

/**
 * One CSV field (RFC 4180): quoted when it holds a comma, quote or line break. Text
 * that a spreadsheet might run as a formula gets a leading apostrophe: text starting
 * with =, +, -, @, their full-width forms (＝＋－＠), or any space, tab or line break
 * (some spreadsheets trim it and read what follows). Numbers are written as they are.
 */
export function csvField(v: string | number | null): string {
  if (v === null) return "";
  if (typeof v === "number") return String(v);
  const safe = /^[\s=+\-@＝＋－＠]/u.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function csvLine(r: SessionRow): string {
  const start = r.startedAt ? Date.parse(r.startedAt) : null;
  const end = r.endedAt ? Date.parse(r.endedAt) : null;
  const fields: Record<(typeof CSV_COLUMNS)[number], string | number | null> = {
    session_ref: r.reference,
    session_type: r.kind,
    status: r.status,
    created_at_utc: r.createdAt,
    started_at_utc: r.startedAt,
    ended_at_utc: r.endedAt,
    time_zone: r.timeZone,
    started_at_local: start === null ? null : isoInZone(start, r.timeZone),
    ended_at_local: end === null ? null : isoInZone(end, r.timeZone),
    duration_seconds: r.durationSeconds,
    site: r.siteName,
    station_id: r.stationId,
    station: r.stationName,
    connector_id: r.connectorId,
    connector_number: r.connectorNumber,
    energy_wh: r.energyWh,
    energy_kwh: r.energyWh === null ? null : whToKwhText(r.energyWh),
    stop_reason: r.stopReason,
    transaction_id: r.transactionId,
    bill_id: r.billId,
    currency: r.kind === "paid" ? r.currency : null,
    hold_minor: r.holdMinor,
    billed_minor: r.billedMinor,
    captured_minor: r.capturedMinor,
    refunded_minor: r.refundedMinor,
    net_minor: r.netMinor,
    refunds_checked_at_utc: r.refundCheckedAt
      ? new Date(r.refundCheckedAt).toISOString()
      : null,
    details: r.detailsPending
      ? "pending"
      : r.transactionId === null
        ? "no_session"
        : "recorded",
  };
  return `${CSV_COLUMNS.map((c) => csvField(fields[c])).join(",")}\r\n`;
}

export const csvHeader = () => `${CSV_COLUMNS.join(",")}\r\n`;

export type CsvResult =
  | { ok: true; body: ReadableStream<Uint8Array>; rows: number }
  | { ok: false; status: 422 | 502 | 504; error: string };

export interface CsvLimits {
  maxRows: number;
  seconds: number;
  pageRows: number;
}

class ExportTimeout extends Error {
  constructor(seconds: number) {
    super(`export ran past ${seconds} seconds`);
    this.name = "ExportTimeout";
  }
}

/** `p`, or an ExportTimeout once `deadline` passes (a database read that hangs). */
async function before<T>(
  p: Promise<T>,
  deadline: number,
  now: () => number,
  seconds: number,
): Promise<T> {
  const left = deadline - now();
  if (left <= 0) throw new ExportTimeout(seconds);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ExportTimeout(seconds)), left);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The export as a stream: the header, then the rows, CSV_PAGE at a time, newest
 * first, each page after the last row of the one before (a keyset on the full
 * database timestamp and the ID, so checkouts made meanwhile shift nothing and rows in
 * the same millisecond are never skipped). It counts the matching rows first: more
 * than CSV_MAX_ROWS, or a database error, is an error status before anything is sent.
 * The stream closes as soon as a page comes back short (or empty). Once streaming, a
 * failed read or a run past the budget (CSV_SECONDS from `startedAt`, the request's
 * start) errors the stream, so the download fails instead of ending as a clean file
 * that is missing rows. Only the kit's database is read: no Ivora request per row.
 */
export async function sessionsCsv(
  d: Pick<ReportsDeps, "store" | "now">,
  f: ReportFilter,
  ctx: StationContext,
  o: { startedAt: number; limits?: CsvLimits },
): Promise<CsvResult> {
  const limits = o.limits ?? {
    maxRows: CSV_MAX_ROWS,
    seconds: CSV_SECONDS,
    pageRows: CSV_PAGE,
  };
  const deadline = o.startedAt + limits.seconds * 1000;
  const timeUp = () => ({
    ok: false as const,
    status: 504 as const,
    error: `The export ran past ${limits.seconds} seconds before it could start. Try again, or pick a shorter period.`,
  });
  let expected: number;
  try {
    expected = (
      await before(d.store.totals(f), deadline, d.now, limits.seconds)
    ).checkouts;
  } catch (e) {
    logFailure("export", e);
    if (e instanceof ExportTimeout) return timeUp();
    return { ok: false, status: 502, error: describeError(e) };
  }
  if (expected > limits.maxRows)
    return {
      ok: false,
      status: 422,
      error: `${expected.toLocaleString("en-US")} sessions match, and one file holds up to ${limits.maxRows.toLocaleString("en-US")}. Pick a shorter period, one charger or one status, and download each part.`,
    };
  if (d.now() >= deadline) return timeUp();
  const enc = new TextEncoder();
  let after: ReportCursor | undefined;
  return {
    ok: true,
    rows: expected,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(csvHeader()));
      },
      async pull(controller) {
        let rows: ReportCheckout[];
        try {
          rows = await before(
            d.store.list(f, { limit: limits.pageRows, after }),
            deadline,
            d.now,
            limits.seconds,
          );
        } catch (e) {
          logFailure("export", e);
          // A cut-off download must not look complete.
          controller.error(e);
          return;
        }
        const last = rows.at(-1);
        if (last) {
          after = { at: last.cursor, id: last.id };
          controller.enqueue(
            enc.encode(rows.map((c) => csvLine(toRow(c, ctx))).join("")),
          );
        }
        // A short or empty page is the last: close now (an empty pull that enqueues
        // nothing would never be pulled again, and the download would hang).
        if (rows.length < limits.pageRows) controller.close();
      },
    }),
  };
}

/** The export's file name: sessions-2026-10-01-to-2026-10-31.csv. */
export function csvFileName(q: ReportQuery): string {
  return `sessions-${q.fromDate}-to-${q.toDate}.csv`;
}

// ---- Payouts ----

/**
 * The payouts page of the operator's own Stripe dashboard (test-mode payouts for a
 * test-mode account). Stripe pays out to the operator's bank; the kit holds no Stripe
 * keys and reads no payouts, so it links there. Stripe asks the operator to sign in.
 */
export function payoutsUrl(livemode: boolean | null): string {
  return livemode === false
    ? "https://dashboard.stripe.com/test/payouts"
    : "https://dashboard.stripe.com/payouts";
}

// ---- The sweep: session details, refunds and captures ----

/** Per sweep run (every minute): well inside Ivora's 180 requests a minute per key. */
export const SWEEP_DETAILS = 10;
export const SWEEP_PAYMENTS = 10;
/**
 * The sweep starts no new read this long after the cron request began (settlement
 * runs first). One read can take 20 s with 429 waits, so the run ends inside the
 * route's maxDuration of 60 seconds; what is left waits for the next run.
 */
export const SWEEP_SECONDS = 30;

/** An ended session's details from GET /transactions/{id}; endedAt null while it runs. */
export function sessionDetails(t: TransactionDetail): SessionDetails {
  const ended = t.active !== true && t.ended_at ? t.ended_at : null;
  const wh = safeInt(t.energy_wh);
  return {
    startedAt: t.started_at,
    endedAt: ended,
    energyWh: wh !== null && wh >= 0 ? wh : null,
    connectorNumber:
      safeInt(t.connector_number) !== null && t.connector_number! > 0
        ? t.connector_number!
        : null,
    stopReason: t.stop_reason ? t.stop_reason.slice(0, 60) : null,
  };
}

const NOTHING: SessionDetails = {
  startedAt: null,
  endedAt: null,
  energyWh: null,
  connectorNumber: null,
  stopReason: null,
};

const nonNegative = (v: number | null | undefined) =>
  Math.max(0, safeInt(v) ?? 0);

/**
 * Called by the settlement sweep after it settles: copies the details of ended
 * sessions (GET /transactions/{id}, once each) and re-reads payments (GET
 * /payments/{id}, once a day for 90 days): charged ones for refunds, and paid
 * checkouts that need you (for example a bill above its hold) in case Ivora's staff
 * captured the hold, which then counts as collected. Read-only towards Ivora: it
 * sends no command and moves no money. A failed read is noted and tried again on a
 * later run, after the others. `startedAt` is the cron request's start.
 */
export async function refreshReportRecords(
  d: Pick<ReportsDeps, "ivora" | "store" | "now">,
  o: { startedAt: number; details?: number; payments?: number },
): Promise<{ details: number; payments: number }> {
  const deadline = o.startedAt + SWEEP_SECONDS * 1000;
  let details = 0;
  let payments = 0;
  if (d.now() >= deadline) return { details, payments };
  for (const due of await d.store.detailsDue(o.details ?? SWEEP_DETAILS)) {
    if (d.now() >= deadline) return { details, payments };
    let found = NOTHING;
    try {
      found = sessionDetails(await d.ivora.getTransaction(due.transactionId));
    } catch (e) {
      logFailure("session details", e);
    }
    await d.store.recordDetails(due.operatorId, due.id, found);
    if (found.endedAt) details++;
  }
  if (d.now() >= deadline) return { details, payments };
  for (const due of await d.store.paymentsDue(o.payments ?? SWEEP_PAYMENTS)) {
    if (d.now() >= deadline) break;
    try {
      const p = await d.ivora.getPayment(due.paymentId);
      await d.store.recordPayment(due.operatorId, due.id, {
        capturedMinor: nonNegative(p.captured_minor),
        refundedMinor: nonNegative(p.refunded_minor),
      });
      payments++;
    } catch (e) {
      // Not recorded: the payment is read again on a later run.
      logFailure("payment check", e);
    }
  }
  return { details, payments };
}
