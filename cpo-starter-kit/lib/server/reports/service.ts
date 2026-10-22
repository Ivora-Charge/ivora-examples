import "server-only";
import { whToKwhText } from "../../units";
import {
  describeError,
  ERRORS_URL,
  IvoraError,
  type Bill,
  type IvoraClient,
  type Location,
  type Station,
  type Stats,
  type StatsBucketSize,
  type TransactionBill,
  type TransactionRecord,
} from "../ivora";
import { isFreeSession, isStaffSession } from "../live/service";
import type { OnboardingStore } from "../onboarding/types";
import type { Staff } from "../team/types";
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
  type ReportQuery,
  type SessionKind,
  type SessionRow,
  type StatusFilter,
} from "./types";

const HOUR_MS = 3_600_000;

/**
 * What reports read. Every read goes to Ivora (or the demo client); the kit's own
 * database only gives the company's time zone and the staff and free charging tokens,
 * so staff/test and free sessions are labelled and never counted as driver revenue.
 */
export interface ReportsDeps {
  ivora: IvoraClient;
  company: Pick<OnboardingStore, "load">;
  /** The operator's staff and free charging tokens (demo mode adds its samples'). */
  tokens(operatorId: string): Promise<{ staff: string[]; free: string[] }>;
  now: () => number;
}

/** How far one session scan reads: pages of 100 transactions, and seconds in total. */
export interface ScanLimits {
  maxPages: number;
  seconds: number;
}
/** The Reports page: up to 1,000 transactions (and 1,000 bills when needed). */
export const PAGE_SCAN: ScanLimits = { maxPages: 10, seconds: 20 };
/** The CSV export: up to 5,000. */
export const CSV_SCAN: ScanLimits = { maxPages: 50, seconds: 50 };
/** Rows the page shows; the CSV has every matching row the scan read. */
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
    },
    error,
  };
}

/** The query as URL parameters, for the CSV link (the same period and filters). */
export function reportSearch(q: ReportQuery): string {
  const p = new URLSearchParams({ period: q.preset });
  if (q.preset === "custom") {
    p.set("from", q.fromDate);
    p.set("to", q.toDate);
    p.set("bucket", q.bucket);
  }
  if (q.stationId !== null) p.set("station", String(q.stationId));
  if (q.status !== "all") p.set("status", q.status);
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

// ---- Sessions ----

/** Stations and sites by ID, and the tokens that mark staff/test and free sessions. */
export interface ScanContext {
  stations: Map<
    number,
    { name: string; siteName: string | null; timeZone: string | null }
  >;
  staffTokens: string[];
  freeTokens: string[];
  /** The report's time zone, for sessions whose site has none. */
  timeZone: string;
}

export function scanContext(
  stations: Station[],
  locations: Location[],
  tokens: { staff: string[]; free: string[] },
  timeZone: string,
): ScanContext {
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
    staffTokens: tokens.staff,
    freeTokens: tokens.free,
    timeZone,
  };
}

/** Staff/test and free first (they never carry revenue), then any session with a bill. */
export function sessionKind(
  t: { id_token?: string | null },
  bill: TransactionBill | null,
  ctx: Pick<ScanContext, "staffTokens" | "freeTokens">,
): SessionKind {
  if (ctx.staffTokens.some((x) => isStaffSession(t, x))) return "staff";
  if (ctx.freeTokens.some((x) => isFreeSession(t, x))) return "free";
  return bill ? "driver" : "other";
}

/** The bills a scan joins to transactions when the list does not carry them. */
interface BillIndex {
  byTransaction: Map<number, TransactionBill>;
  /** Open bills by connector ID, newest first: an active session's bill. */
  openByConnector: Map<number, Bill[]>;
}

const asTransactionBill = (b: Bill): TransactionBill => ({
  id: b.id,
  status: b.status,
  currency: b.currency,
  total_minor: b.total_minor,
  finalized_at: b.finalized_at,
});

async function readBills(
  ivora: IvoraClient,
  stationId: number | null,
  limits: ScanLimits,
  deadline: number,
  now: () => number,
): Promise<{ index: BillIndex; truncated: boolean }> {
  const index: BillIndex = {
    byTransaction: new Map(),
    openByConnector: new Map(),
  };
  let after: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= limits.maxPages || (page > 0 && now() > deadline))
      return { index, truncated: true };
    const res = await ivora.listBillPage({
      after,
      limit: 100,
      station_id: stationId ?? undefined,
    });
    for (const b of res.data) {
      if (b.transaction_id !== null)
        index.byTransaction.set(b.transaction_id, asTransactionBill(b));
      else if (b.status === "open") {
        const list = index.openByConnector.get(b.connector_id) ?? [];
        list.push(b);
        index.openByConnector.set(b.connector_id, list);
      }
    }
    const next = res.next_cursor;
    if (!next || !res.data.length || next === after)
      return { index, truncated: false };
    after = next;
  }
}

/**
 * A transaction's bill: the one the list carries, else the bill finalized with it,
 * else (while it charges) the open bill on its connector made in the two hours before
 * it started. Null for a session that settles no bill.
 */
function billFor(
  t: TransactionRecord,
  index: BillIndex | null,
): TransactionBill | null {
  if (t.bill !== undefined) return t.bill;
  if (!index) return null;
  const found = index.byTransaction.get(t.id);
  if (found) return found;
  const start = Date.parse(t.started_at ?? "");
  if (t.ended_at || t.connector_id === null || Number.isNaN(start)) return null;
  const open = (index.openByConnector.get(t.connector_id) ?? [])
    .filter((b) => {
      const made = Date.parse(b.created_at);
      return made <= start && start - made <= 2 * HOUR_MS;
    })
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  return open ? asTransactionBill(open) : null;
}

export function toRow(
  t: TransactionRecord,
  bill: TransactionBill | null,
  ctx: ScanContext,
): SessionRow | null {
  const start = Date.parse(t.started_at ?? "");
  if (Number.isNaN(start)) return null;
  const end = t.ended_at ? Date.parse(t.ended_at) : NaN;
  const st = t.station_id !== null ? ctx.stations.get(t.station_id) : undefined;
  const ended = !Number.isNaN(end) || t.active === false;
  return {
    id: t.id,
    stationId: t.station_id,
    stationName:
      st?.name ??
      t.station_name ??
      (t.station_id !== null ? `Charger ${t.station_id}` : "Unknown charger"),
    siteName: st?.siteName ?? null,
    timeZone: st?.timeZone ?? ctx.timeZone,
    connectorId: t.connector_id,
    connectorNumber: t.connector_number ?? null,
    startedAt: new Date(start).toISOString(),
    endedAt: Number.isNaN(end) ? null : new Date(end).toISOString(),
    durationSeconds:
      typeof t.duration_seconds === "number"
        ? t.duration_seconds
        : Number.isNaN(end)
          ? null
          : Math.round((end - start) / 1000),
    energyWh:
      typeof t.energy_wh === "number" && Number.isSafeInteger(t.energy_wh)
        ? t.energy_wh
        : null,
    kind: sessionKind(t, bill, ctx),
    status: ended ? "ended" : "charging",
    stopReason: t.stop_reason ?? null,
    billId: bill?.id ?? null,
    billStatus: bill?.status ?? null,
    amountMinor:
      bill?.status === "final" && Number.isSafeInteger(bill.total_minor)
        ? bill.total_minor
        : null,
    currency: bill?.currency ?? null,
  };
}

export function matchesStatus(r: SessionRow, status: StatusFilter): boolean {
  switch (status) {
    case "all":
      return true;
    case "charging":
      return r.status === "charging";
    case "ended":
      return r.status === "ended";
    case "billed":
      return r.status === "ended" && r.billStatus === "final";
    case "unbilled":
      return r.status === "ended" && r.billStatus !== "final";
  }
}

/**
 * The period's sessions that match the filters, one array per page of transactions,
 * in the order Ivora lists them. Transactions have no date filter in the API, so the
 * scan reads page after page (with the station filter when one is chosen) and keeps
 * those that started in the period. It stops at the last page, at the limits
 * (returning truncated), or, when pages come newest first, at the first page that
 * ends before the period. Bills are read only if the list does not carry them.
 */
export async function* scanSessions(
  d: Pick<ReportsDeps, "ivora" | "now">,
  q: ReportQuery,
  ctx: ScanContext,
  limits: ScanLimits,
): AsyncGenerator<SessionRow[], { truncated: boolean }> {
  const deadline = d.now() + limits.seconds * 1000;
  let index: BillIndex | null = null;
  let billsTruncated = false;
  let after: number | undefined;
  for (let page = 0; ; page++) {
    if (page >= limits.maxPages || (page > 0 && d.now() > deadline))
      return { truncated: true };
    const res = await d.ivora.listTransactionPage({
      after,
      limit: 100,
      station_id: q.stationId ?? undefined,
    });
    if (!index && res.data.some((t) => t.bill === undefined)) {
      const read = await readBills(
        d.ivora,
        q.stationId,
        limits,
        deadline,
        d.now,
      );
      index = read.index;
      billsTruncated = read.truncated;
    }
    const rows: SessionRow[] = [];
    const starts: number[] = [];
    for (const t of res.data) {
      const start = Date.parse(t.started_at ?? "");
      if (!Number.isNaN(start)) starts.push(start);
      if (Number.isNaN(start) || start < q.fromMs || start >= q.toMs) continue;
      if (q.stationId !== null && t.station_id !== q.stationId) continue;
      const row = toRow(t, billFor(t, index), ctx);
      if (row && matchesStatus(row, q.status)) rows.push(row);
    }
    if (rows.length) yield rows;
    const next = res.next_cursor;
    if (!next || !res.data.length || (after !== undefined && next === after))
      return { truncated: billsTruncated };
    const newestFirst = starts.every((s, i) => i === 0 || s <= starts[i - 1]);
    if (newestFirst && starts.length && starts[starts.length - 1] < q.fromMs)
      return { truncated: billsTruncated };
    after = next;
  }
}

/** The table's totals: driver revenue counts final bills of driver sessions only. */
export interface SessionSummary {
  sessions: number;
  energyWh: number;
  byKind: Record<SessionKind, number>;
  /** Final bills of driver sessions, per currency, integer minor units. */
  driverRevenue: { currency: string; amountMinor: number; bills: number }[];
}

export function summarize(rows: SessionRow[]): SessionSummary {
  const byKind: Record<SessionKind, number> = {
    driver: 0,
    free: 0,
    staff: 0,
    other: 0,
  };
  const revenue = new Map<string, { amountMinor: number; bills: number }>();
  let energyWh = 0;
  for (const r of rows) {
    byKind[r.kind] += 1;
    energyWh += r.energyWh ?? 0;
    if (r.kind === "driver" && r.amountMinor !== null && r.currency) {
      const line = revenue.get(r.currency) ?? { amountMinor: 0, bills: 0 };
      line.amountMinor += r.amountMinor;
      line.bills += 1;
      revenue.set(r.currency, line);
    }
  }
  return {
    sessions: rows.length,
    energyWh,
    byKind,
    driverRevenue: [...revenue.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([currency, v]) => ({ currency, ...v })),
  };
}

export type SessionsResult =
  | {
      ok: true;
      /** Newest first, at most PAGE_ROWS. */
      rows: SessionRow[];
      summary: SessionSummary;
      truncated: boolean;
    }
  | { ok: false; error: string };

export async function loadSessions(
  d: Pick<ReportsDeps, "ivora" | "now">,
  q: ReportQuery,
  ctx: ScanContext,
  limits = PAGE_SCAN,
): Promise<SessionsResult> {
  try {
    const all: SessionRow[] = [];
    const scan = scanSessions(d, q, ctx, limits);
    let step = await scan.next();
    while (!step.done) {
      all.push(...step.value);
      step = await scan.next();
    }
    all.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id - a.id);
    return {
      ok: true,
      rows: all.slice(0, PAGE_ROWS),
      summary: summarize(all),
      truncated: step.value.truncated,
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
  scan: ScanContext;
}

/**
 * What the page and the export need before reading sessions: the time zone, the
 * period, the stations (names, sites, the station filter) and the tokens.
 */
export async function loadReportsContext(
  d: ReportsDeps,
  staff: Staff,
  params: Params,
): Promise<
  { ok: true; context: ReportsContext } | { ok: false; error: string }
> {
  try {
    const [profile, stations, locations, tokens] = await Promise.all([
      d.company.load(staff.operatorId).catch(() => null),
      d.ivora.listAllStations(),
      d.ivora.listAllLocations(),
      d.tokens(staff.operatorId),
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
        scan: scanContext(stations.data, locations.data, tokens, tz.zone),
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
  "session_id",
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
  "session_type",
  "status",
  "stop_reason",
  "bill_id",
  "bill_status",
  "amount_minor",
  "currency",
] as const;

const CSV_KIND: Record<SessionKind, string> = {
  driver: "driver",
  free: "free",
  staff: "staff_test",
  other: "other",
};

/**
 * One CSV field (RFC 4180): quoted when it holds a comma, quote or line break. Text
 * that a spreadsheet would run as a formula (=, +, -, @, tab, CR first) gets a leading
 * apostrophe; numbers are written as they are.
 */
export function csvField(v: string | number | null): string {
  if (v === null) return "";
  if (typeof v === "number") return String(v);
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function csvLine(r: SessionRow): string {
  const start = Date.parse(r.startedAt);
  const end = r.endedAt ? Date.parse(r.endedAt) : null;
  const fields: Record<(typeof CSV_COLUMNS)[number], string | number | null> = {
    session_id: r.id,
    started_at_utc: r.startedAt,
    ended_at_utc: r.endedAt,
    time_zone: r.timeZone,
    started_at_local: isoInZone(start, r.timeZone),
    ended_at_local: end === null ? null : isoInZone(end, r.timeZone),
    duration_seconds: r.durationSeconds,
    site: r.siteName,
    station_id: r.stationId,
    station: r.stationName,
    connector_id: r.connectorId,
    connector_number: r.connectorNumber,
    energy_wh: r.energyWh,
    energy_kwh: r.energyWh === null ? null : whToKwhText(r.energyWh),
    session_type: CSV_KIND[r.kind],
    status: r.status,
    stop_reason: r.stopReason,
    bill_id: r.billId,
    bill_status: r.billStatus,
    amount_minor: r.amountMinor,
    currency: r.currency,
  };
  return `${CSV_COLUMNS.map((c) => csvField(fields[c])).join(",")}\r\n`;
}

export const csvHeader = () => `${CSV_COLUMNS.join(",")}\r\n`;

/**
 * The export as a stream: the header, then each page's rows as soon as it is read.
 * The first page is read before the response starts, so an API error becomes an
 * error status rather than a cut-off file.
 */
export async function sessionsCsv(
  d: Pick<ReportsDeps, "ivora" | "now">,
  q: ReportQuery,
  ctx: ScanContext,
  limits = CSV_SCAN,
): Promise<ReadableStream<Uint8Array>> {
  const scan = scanSessions(d, q, ctx, limits);
  const first = await scan.next();
  const enc = new TextEncoder();
  let pending: IteratorResult<SessionRow[], { truncated: boolean }> | null =
    first;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(csvHeader()));
    },
    async pull(controller) {
      try {
        const step = pending ?? (await scan.next());
        pending = null;
        if (step.done) {
          if (step.value.truncated)
            console.warn(
              "cpo-starter-kit: reports export stopped at its page limit",
            );
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(step.value.map(csvLine).join("")));
      } catch (e) {
        logFailure("export", e);
        // A cut-off download must not look complete.
        controller.error(e);
      }
    },
    async cancel() {
      await scan.return({ truncated: true });
    },
  });
}

/** The export's file name: sessions-2026-10-01-to-2026-10-31.csv. */
export function csvFileName(q: ReportQuery): string {
  return `sessions-${q.fromDate}-to-${q.toDate}.csv`;
}

// ---- Payouts ----

/**
 * The payouts page of the operator's own Stripe dashboard (test-mode payouts for a
 * test-mode account). Stripe pays out to the operator's bank; the kit holds no Stripe
 * keys and reads no payouts, so it links there.
 */
export function payoutsUrl(livemode: boolean | null): string {
  return livemode === false
    ? "https://dashboard.stripe.com/test/payouts"
    : "https://dashboard.stripe.com/payouts";
}
