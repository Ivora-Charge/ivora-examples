import "server-only";
import type { StatsBucketSize } from "../ivora/types";
import { localDate, nextDate, offsetMs, zonedToUtc } from "../pricing/time";

// Report periods in the report's time zone. Timestamps stay UTC instants (ms); these
// helpers find bucket boundaries (local midnight, the first of the month, the local
// hour) and show instants in a zone, the way Ivora's GET /stats buckets them.

const HOUR_MS = 3_600_000;

/** Ivora's limits for one stats request (more answers 422 stats_range_too_large). */
export const MAX_BUCKETS: Record<StatsBucketSize, number> = {
  hour: 168,
  day: 92,
  month: 24,
};
export const MAX_STATS_SESSIONS = 50_000;

/** Whether `zone` is an IANA time zone this runtime knows. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone.length > 0 && zone.length <= 64;
  } catch {
    return false;
  }
}

/** The local first of the month (YYYY-MM-01) `months` after `date`'s month. */
function monthStart(date: string, months = 0): string {
  const [y, m] = date.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return d.toISOString().slice(0, 10);
}

/** The start of the bucket holding instant `ms`. */
export function bucketFloor(
  ms: number,
  bucket: StatsBucketSize,
  zone: string,
): number {
  if (bucket === "hour") {
    // The local hour: zones with half-hour offsets start hours at :30 UTC.
    const local = ms + offsetMs(zone, ms);
    return ms - (((local % HOUR_MS) + HOUR_MS) % HOUR_MS);
  }
  const date = localDate(zone, ms);
  return zonedToUtc(
    bucket === "day" ? date : monthStart(date),
    "00:00",
    zone,
  ).getTime();
}

/** The start of the bucket after the one starting at `start`. */
export function bucketNext(
  start: number,
  bucket: StatsBucketSize,
  zone: string,
): number {
  if (bucket === "hour") return start + HOUR_MS;
  const date = localDate(zone, start);
  return zonedToUtc(
    bucket === "day" ? nextDate(date) : monthStart(date, 1),
    "00:00",
    zone,
  ).getTime();
}

/** `ms` rounded up to a bucket boundary. */
export function bucketCeil(
  ms: number,
  bucket: StatsBucketSize,
  zone: string,
): number {
  const floor = bucketFloor(ms, bucket, zone);
  return floor === ms ? ms : bucketNext(floor, bucket, zone);
}

/**
 * Buckets from `from` to `to` once widened to whole buckets; stops counting past
 * `limit` (enough to know the period is too long).
 */
export function countBuckets(
  from: number,
  to: number,
  bucket: StatsBucketSize,
  zone: string,
  limit = 10_000,
): number {
  let n = 0;
  const end = bucketCeil(to, bucket, zone);
  for (
    let t = bucketFloor(from, bucket, zone);
    t < end && n <= limit;
    t = bucketNext(t, bucket, zone)
  )
    n++;
  return n;
}

/** An instant as ISO 8601 in `zone`, with its offset: 2026-10-01T10:00:00-07:00. */
export function isoInZone(ms: number, zone: string): string {
  const off = offsetMs(zone, ms);
  const wall = new Date(Math.floor(ms / 1000) * 1000 + off)
    .toISOString()
    .slice(0, 19);
  if (off === 0) return `${wall}+00:00`;
  const abs = Math.abs(off) / 60_000;
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${wall}${off < 0 ? "-" : "+"}${hh}:${mm}`;
}

/** An instant for a table cell in `zone`: "2026-10-01 10:00". */
export function shortInZone(ms: number, zone: string): string {
  return isoInZone(ms, zone).slice(0, 16).replace("T", " ");
}

export { localDate, nextDate, zonedToUtc };
