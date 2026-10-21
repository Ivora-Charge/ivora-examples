import "server-only";

// Local wall-clock times in an IANA time zone, to and from UTC instants. The tariff's
// periods and the preview session are in the tariff's time zone; the API takes start
// times as ISO 8601 with an offset (we send UTC) plus the zone.

const DAY_MS = 86_400_000;

/** The zone's offset from UTC at instant `ms`, in ms (local = UTC + offset). */
function offsetMs(zone: string, ms: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(ms)
      .map((x) => [x.type, x.value]),
  );
  const wall = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return wall - Math.floor(ms / 1000) * 1000;
}

/** A local date and time as if it were UTC (ms), for arithmetic on wall clocks. */
function wallMs(date: string, time: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h, mi);
}

/**
 * Every UTC instant whose local time in `zone` is this wall clock, earliest first:
 * one normally, two in the hour clocks fall back, none in the gap they spring forward.
 * Uses the offsets a day either side, so it assumes at most one change a day.
 */
function instants(wall: number, zone: string): number[] {
  const offsets = new Set([
    offsetMs(zone, wall - DAY_MS),
    offsetMs(zone, wall + DAY_MS),
  ]);
  return [...offsets]
    .map((o) => wall - o)
    .filter((ms) => offsetMs(zone, ms) === wall - ms)
    .sort((a, b) => a - b);
}

/**
 * The UTC instant of a local date and time (YYYY-MM-DD, HH:MM) in `zone`. A time that
 * happens twice (clocks fall back) is the first. A time that does not exist (clocks
 * spring forward) moves forward by the gap, as a clock that was not changed would
 * read: 02:30 on a US spring-forward day is 03:30, and in the EU too.
 */
export function zonedToUtc(date: string, time: string, zone: string): Date {
  const wall = wallMs(date, time);
  const found = instants(wall, zone);
  if (found.length) return new Date(found[0]);
  // In the gap: the offset from before the change puts it past the gap.
  return new Date(wall - offsetMs(zone, wall - DAY_MS));
}

/** Whether a local date and time happens in `zone` (false in a spring-forward gap). */
export function localTimeExists(
  date: string,
  time: string,
  zone: string,
): boolean {
  return instants(wallMs(date, time), zone).length > 0;
}

/** The local date (YYYY-MM-DD) after `date`. */
export function nextDate(date: string): string {
  return new Date(wallMs(date, "00:00") + DAY_MS).toISOString().slice(0, 10);
}

/** Today's local date (YYYY-MM-DD) in `zone`. */
export function localDate(zone: string, now = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Elapsed minutes from `start` on `date` to `end` (on the next day when it is not
 * later), in `zone`: real time, so 01:00 to 03:00 is 60 minutes on a day clocks spring
 * forward and 180 on a day they fall back.
 */
export function elapsedMinutes(
  date: string,
  start: string,
  end: string,
  zone: string,
): number {
  const endDate = end > start ? date : nextDate(date);
  return Math.round(
    (zonedToUtc(endDate, end, zone).getTime() -
      zonedToUtc(date, start, zone).getTime()) /
      60_000,
  );
}
