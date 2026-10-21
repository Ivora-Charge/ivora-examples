import "server-only";

// Local wall-clock times in an IANA time zone, to and from UTC instants. The tariff's
// periods and the preview session are in the tariff's time zone; the API takes start
// times as ISO 8601 with an offset (we send UTC) plus the zone.

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

/**
 * The UTC instant of a local date and time (YYYY-MM-DD, HH:MM) in `zone`. A time that
 * does not exist (clocks spring forward) moves past the gap; one that happens twice
 * (clocks fall back) is the first.
 */
export function zonedToUtc(date: string, time: string, zone: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let ms = wall - offsetMs(zone, wall);
  // A second pass settles instants next to an offset change.
  ms = wall - offsetMs(zone, ms);
  return new Date(ms);
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

/** Minutes from a start time to an end time, past midnight when the end is earlier. */
export function minutesBetween(start: string, end: string): number {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return (m(end) - m(start) + 1440) % 1440;
}
