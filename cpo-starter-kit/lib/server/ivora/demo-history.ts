import "server-only";
import { createHash } from "node:crypto";
import {
  bucketCeil,
  bucketFloor,
  bucketNext,
  countBuckets,
  isoInZone,
  MAX_BUCKETS,
  MAX_STATS_SESSIONS,
} from "../reports/time";
import { whToKwhText } from "../../units";
import type { ReportCheckout } from "../reports/types";
import { IvoraError } from "./errors";
import type {
  Bill,
  RevenueLine,
  Station,
  Stats,
  StatsFigures,
  StatsQuery,
  TransactionDetail,
} from "./types";

// Six months of sample charging history for demo-mode reports, made up offline from a
// hash of each day (the same days always get the same sessions). Every station is a
// DEMO- sample charger; every amount is a sample bill that nobody paid. Driver-paid and
// free sessions also get the kit's own checkout record (what the sessions table and
// the CSV read); staff/test and RFID sessions are only in Ivora's figures, as they
// would be for a real operator.

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
export const DEMO_HISTORY_DAYS = 180;

/** The sample chargers' connectors: station, connector ID and number, power (W). */
const CONNECTORS = [
  { station: 9101, name: "DEMO-HARBOUR-01", id: 91011, number: 1, w: 7_400 },
  { station: 9101, name: "DEMO-HARBOUR-01", id: 91012, number: 2, w: 11_000 },
  { station: 9102, name: "DEMO-HARBOUR-02", id: 91021, number: 1, w: 7_400 },
  { station: 9102, name: "DEMO-HARBOUR-02", id: 91022, number: 2, w: 11_000 },
  { station: 9103, name: "DEMO-MARKET-01", id: 91031, number: 1, w: 50_000 },
];
const RATE_MINOR_PER_KWH = 35;
const SESSION_FEE_MINOR = 100;
const HOLD_MINOR = 2500;

/** OCPP stop reasons Ivora does not count as a successful session. */
const FAILED_STOPS = new Set([
  "EmergencyStop",
  "HardReset",
  "SoftReset",
  "ImmediateReset",
  "Reboot",
  "PowerLoss",
  "PowerQuality",
  "Timeout",
  "DeAuthorized",
  "Faulted",
  "GroundFault",
  "OvercurrentFault",
]);

export interface DemoHistory {
  /** Every sample session, as Ivora's statistics count them. */
  transactions: TransactionDetail[];
  /** Final bills of driver-paid sessions. */
  bills: Bill[];
  /** The kit's checkout records (paid and free), newest first. */
  checkouts: ReportCheckout[];
}

const bytes = (s: string) => createHash("sha256").update(s).digest();
const ISO = (ms: number) => new Date(ms).toISOString();
/** A stable, made-up UUID for a sample record (never a real checkout's). */
const uuid = (b: Buffer) => {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

let cached: { day: number; history: DemoHistory } | null = null;

/**
 * The sample sessions up to `now`: 3 to 7 a day over DEMO_HISTORY_DAYS days. About
 * 60% are paid by drivers, 10% free, 10% staff/test and the rest RFID cards. Of the
 * paid ones: one tap in 20 never paid (the hold was released, no session), a bill above
 * the $25 hold needs the operator, and one charged session in 25 was refunded. One
 * session in 16 ends on a power loss and one in 16 delivers nothing.
 */
export function demoHistory(now: number): DemoHistory {
  const today = Math.floor(now / DAY_MS);
  if (cached?.day === today) return filterToNow(cached.history, now);
  const transactions: TransactionDetail[] = [];
  const bills: Bill[] = [];
  const checkouts: ReportCheckout[] = [];
  for (let d = 0; d < DEMO_HISTORY_DAYS; d++) {
    const day = today - d;
    const count = 3 + (bytes(`demo-day-${day}`)[0] % 5);
    for (let i = 0; i < count; i++) {
      const b = bytes(`demo-session-${day}-${i}`);
      const c = CONNECTORS[b[0] % CONNECTORS.length];
      const start =
        day * DAY_MS + (6 + (b[1] % 16)) * 3_600_000 + (b[2] % 60) * MINUTE_MS;
      const minutes = 15 + ((b[3] * 256 + b[4]) % 210);
      const end = start + minutes * MINUTE_MS;
      const fault = b[6] % 16 === 0;
      const empty = b[6] % 16 === 1;
      const energyWh = empty
        ? 0
        : Math.min(75_000, Math.round((c.w * minutes) / 60));
      const roll = b[7] % 100;
      const kind =
        roll < 60 ? "paid" : roll < 70 ? "free" : roll < 80 ? "staff" : "rfid";
      const id = day * 10 + i;
      const billId = `bill_${b.subarray(8, 24).toString("hex")}`;
      const tapped = start - 90_000;
      const settledAt = end + 2 * MINUTE_MS;
      const base: ReportCheckout = {
        id: uuid(bytes(`demo-checkout-${day}-${i}`)),
        reference: `ck_${b.subarray(16, 32).toString("hex")}`,
        kind: kind === "free" ? "free" : "paid",
        stationId: c.station,
        connectorId: c.id,
        phase: "settled",
        alert: null,
        createdAt: ISO(tapped),
        cursor: ISO(tapped),
        settledAt: ISO(settledAt),
        transactionId: id,
        billId: null,
        holdMinor: kind === "free" ? 0 : HOLD_MINOR,
        currency: "USD",
        finalMinor: null,
        capturedMinor: null,
        refundedMinor: null,
        refundCheckedAt: null,
        meterWh: null,
        sessionStartedAt: ISO(start),
        sessionEndedAt: ISO(end),
        energyWh,
        connectorNumber: c.number,
        stopReason: fault ? "PowerLoss" : empty ? "EVDisconnected" : "Local",
        detailAt: ISO(settledAt + MINUTE_MS),
      };
      if (kind === "paid" && b[5] % 20 === 0) {
        // The driver never paid: the hold was released and nothing charged.
        checkouts.push({
          ...base,
          phase: "released",
          settledAt: ISO(tapped + 30 * MINUTE_MS),
          transactionId: null,
          billId,
          sessionStartedAt: null,
          sessionEndedAt: null,
          energyWh: null,
          connectorNumber: null,
          stopReason: null,
          detailAt: null,
        });
        continue;
      }
      transactions.push({
        id,
        station_id: c.station,
        station_name: c.name,
        connector_id: c.id,
        connector_number: c.number,
        active: false,
        started_at: ISO(start),
        ended_at: ISO(end),
        duration_seconds: minutes * 60,
        stop_reason: base.stopReason,
        energy_wh: energyWh,
      });
      if (kind === "free") checkouts.push(base);
      if (kind !== "paid") continue;
      const total =
        SESSION_FEE_MINOR + Math.round((RATE_MINOR_PER_KWH * energyWh) / 1000);
      bills.push({
        id: billId,
        station_id: c.station,
        connector_id: c.id,
        tariff_id: 9401,
        hold_minor: HOLD_MINOR,
        currency: "USD",
        status: "final",
        total_minor: total,
        transaction_id: id,
        created_at: ISO(tapped),
        finalized_at: ISO(settledAt),
      });
      const above = total > HOLD_MINOR;
      // Above the hold: some since captured by Ivora's staff (the hold, not the bill).
      const holdCaptured = above && b[6] % 2 === 0;
      const refunded = !above && b[5] % 25 === 1;
      const checked = settledAt + 3_600_000;
      const captured = above ? (holdCaptured ? HOLD_MINOR : null) : total;
      checkouts.push({
        ...base,
        billId,
        phase: above ? "attention" : "settled",
        finalMinor: total,
        capturedMinor: captured,
        refundedMinor: captured === null ? null : refunded ? total : 0,
        refundCheckedAt: above && !holdCaptured ? null : ISO(checked),
      });
    }
  }
  transactions.sort(
    (a, b) => Date.parse(b.started_at!) - Date.parse(a.started_at!),
  );
  checkouts.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  cached = { day: today, history: { transactions, bills, checkouts } };
  return filterToNow(cached.history, now);
}

/**
 * Leaves out what has not happened by `now`: today's later sessions (the demo has its
 * own live ones), and records the sweep would not have written yet.
 */
function filterToNow(h: DemoHistory, now: number): DemoHistory {
  const by = (iso: string | null) => iso !== null && Date.parse(iso) <= now;
  const done = h.transactions.filter(
    (t) => Date.parse(t.ended_at!) + 2 * MINUTE_MS <= now,
  );
  const ids = new Set(done.map((t) => t.id));
  return {
    transactions: done,
    bills: h.bills.filter((b) => ids.has(b.transaction_id!)),
    checkouts: h.checkouts
      .filter((c) => by(c.settledAt))
      .map((c) => ({
        ...c,
        ...(by(c.detailAt) ? {} : NO_DETAILS),
        refundCheckedAt: by(c.refundCheckedAt) ? c.refundCheckedAt : null,
      })),
  };
}

const NO_DETAILS = {
  sessionStartedAt: null,
  sessionEndedAt: null,
  energyWh: null,
  connectorNumber: null,
  stopReason: null,
  detailAt: null,
} satisfies Partial<ReportCheckout>;

function figures(txs: TransactionDetail[]): StatsFigures & {
  active: number;
  unknown: number;
} {
  const ended = txs.filter((t) => t.ended_at);
  const ok = ended.filter(
    (t) => (t.energy_wh ?? 0) >= 1 && !FAILED_STOPS.has(t.stop_reason ?? ""),
  );
  const known = txs.filter(
    (t) =>
      typeof t.energy_wh === "number" &&
      t.energy_wh >= 0 &&
      t.energy_wh <= 1_000_000,
  );
  const wh = known.reduce((n, t) => n + t.energy_wh!, 0);
  const seconds = ended.reduce(
    (n, t) => n + (Date.parse(t.ended_at!) - Date.parse(t.started_at!)) / 1000,
    0,
  );
  const rate = ended.length
    ? Math.round((ok.length * 10_000) / ended.length)
    : null;
  return {
    sessions: txs.length,
    ended_sessions: ended.length,
    successful_sessions: ok.length,
    success_rate:
      rate === null
        ? null
        : `${Math.floor(rate / 10_000)}.${String(rate % 10_000).padStart(4, "0")}`,
    average_duration_seconds: ended.length
      ? Math.round(seconds / ended.length)
      : null,
    energy_kwh: whToKwhText(wh),
    energy_wh: wh,
    active: txs.length - ended.length,
    unknown: txs.length - known.length,
  };
}

function revenue(bills: Bill[]): RevenueLine[] {
  const by = new Map<string, RevenueLine>();
  for (const b of bills) {
    const line = by.get(b.currency) ?? {
      currency: b.currency,
      billed_minor: 0,
      bills: 0,
    };
    line.billed_minor += b.total_minor ?? 0;
    line.bills += 1;
    by.set(b.currency, line);
  }
  return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * An offline stand-in for `GET /stats`, following its documented rules: the period
 * widened to whole buckets in the time zone, sessions in the bucket they started in,
 * revenue from final bills by finalized_at, the same bucket and session limits
 * (422 stats_range_too_large).
 */
export function demoStats(
  q: StatsQuery,
  transactions: TransactionDetail[],
  bills: Bill[],
  stations: Station[],
  now: number,
): Stats {
  const from = Date.parse(q.from);
  const to = Date.parse(q.to);
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to)
    throw new IvoraError(422, "validation_error", "from must be before to");
  const max = MAX_BUCKETS[q.bucket];
  const n = countBuckets(from, to, q.bucket, q.time_zone, max);
  if (n > max)
    throw new IvoraError(
      422,
      "stats_range_too_large",
      `The period has more than ${max} ${q.bucket} buckets`,
      undefined,
      undefined,
      { max_buckets: max, max_sessions: MAX_STATS_SESSIONS },
    );
  const start = bucketFloor(from, q.bucket, q.time_zone);
  const end = bucketCeil(to, q.bucket, q.time_zone);
  const startedIn = (a: number, b: number) =>
    transactions.filter((t) => {
      const s = Date.parse(t.started_at ?? "");
      return s >= a && s < b;
    });
  const finalIn = (a: number, b: number) =>
    bills.filter((x) => {
      const f = Date.parse(x.finalized_at ?? "");
      return x.status === "final" && f >= a && f < b;
    });
  const all = startedIn(start, end);
  const series = [];
  for (let t = start; t < end;) {
    const next = bucketNext(t, q.bucket, q.time_zone);
    const f = figures(startedIn(t, next));
    series.push({
      start: isoInZone(t, q.time_zone),
      end: isoInZone(next, q.time_zone),
      sessions: f.sessions,
      ended_sessions: f.ended_sessions,
      successful_sessions: f.successful_sessions,
      success_rate: f.success_rate,
      average_duration_seconds: f.average_duration_seconds,
      energy_kwh: f.energy_kwh,
      energy_wh: f.energy_wh,
      revenue: revenue(finalIn(t, next)),
    });
    t = next;
  }
  const total = figures(all);
  const byStation = new Map<number, { sessions: number; wh: number }>();
  for (const t of all) {
    if (t.station_id === null) continue;
    const s = byStation.get(t.station_id) ?? { sessions: 0, wh: 0 };
    s.sessions += 1;
    s.wh += t.energy_wh ?? 0;
    byStation.set(t.station_id, s);
  }
  const faulted = (s: Station) =>
    s.online && s.connectors.some((c) => c.status === "Faulted");
  return {
    bucket: q.bucket,
    time_zone: q.time_zone,
    start: isoInZone(start, q.time_zone),
    end: isoInZone(end, q.time_zone),
    sessions_as_of: ISO(now),
    totals: {
      sessions: total.sessions,
      ended_sessions: total.ended_sessions,
      successful_sessions: total.successful_sessions,
      success_rate: total.success_rate,
      average_duration_seconds: total.average_duration_seconds,
      energy_kwh: total.energy_kwh,
      energy_wh: total.energy_wh,
      active_sessions: total.active,
      energy_unknown_sessions: total.unknown,
    },
    series,
    top_stations: [...byStation.entries()]
      .sort((a, b) => b[1].wh - a[1].wh || a[0] - b[0])
      .slice(0, q.top)
      .map(([id, s]) => ({
        station_id: id,
        name: stations.find((x) => x.id === id)?.name ?? null,
        sessions: s.sessions,
        energy_kwh: whToKwhText(s.wh),
        energy_wh: s.wh,
      })),
    stations: {
      as_of: ISO(now),
      total: stations.length,
      online: stations.filter((s) => s.online && !faulted(s)).length,
      offline: stations.filter((s) => !s.online).length,
      faulted: stations.filter(faulted).length,
    },
    revenue: { basis: "final_bills", currencies: revenue(finalIn(start, end)) },
  };
}
