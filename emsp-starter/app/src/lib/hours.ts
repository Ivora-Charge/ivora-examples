import type { OpeningTimes } from "./types";

/** Weekday (1 is Monday, as in OCPI) and minutes since midnight at `now` in `timeZone`. */
export function localTime(
  now: Date,
  timeZone: string,
): { weekday: number; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    // An unknown time zone: the device's own clock is the best guess.
    return {
      weekday: ((now.getDay() + 6) % 7) + 1,
      minutes: now.getHours() * 60 + now.getMinutes(),
    };
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday =
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday")) +
    1;
  return {
    weekday,
    minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")),
  };
}

const mins = (hhmm: string) => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

const within = (
  now: Date,
  ranges?: { period_begin: string; period_end: string }[],
) =>
  (ranges ?? []).some(
    (r) =>
      Date.parse(r.period_begin) <= now.getTime() &&
      now.getTime() < Date.parse(r.period_end),
  );

/**
 * Whether a location is open at `now`: true, false, or undefined when it publishes no
 * opening times (OCPI leaves that unknown; the app does not hide such places).
 * A period may run past midnight (22:00 to 06:00); an end of 00:00 means midnight.
 */
export function isOpenAt(
  opening: OpeningTimes | undefined,
  timeZone: string,
  now = new Date(),
): boolean | undefined {
  if (!opening) return undefined;
  if (within(now, opening.exceptional_closings)) return false;
  if (within(now, opening.exceptional_openings)) return true;
  if (opening.twentyfourseven) return true;
  const { weekday, minutes } = localTime(now, timeZone);
  const yesterday = weekday === 1 ? 7 : weekday - 1;
  return (opening.regular_hours ?? []).some((h) => {
    const begin = mins(h.period_begin);
    let end = mins(h.period_end);
    if (Number.isNaN(begin) || Number.isNaN(end)) return false;
    if (end === 0) end = 24 * 60;
    if (end > begin)
      return h.weekday === weekday && minutes >= begin && minutes < end;
    // Past midnight: the evening of its own day, or the early hours of the next.
    return (
      (h.weekday === weekday && minutes >= begin) ||
      (h.weekday === yesterday && minutes < end)
    );
  });
}

export type HoursRow = {
  /** First and last weekday of a run of days with the same hours (1 is Monday). */
  from: number;
  to: number;
  /** Empty: closed. */
  periods: { begin: string; end: string }[];
};

/** Regular hours as rows, days with the same hours grouped: "Mon–Sat 07:00–23:00", "Sun closed". */
export function hoursRows(opening: OpeningTimes | undefined): HoursRow[] {
  if (!opening || opening.twentyfourseven) return [];
  const byDay = [1, 2, 3, 4, 5, 6, 7].map((d) =>
    (opening.regular_hours ?? [])
      .filter((h) => h.weekday === d)
      .map((h) => ({ begin: h.period_begin, end: h.period_end }))
      .sort((a, b) => a.begin.localeCompare(b.begin)),
  );
  const rows: HoursRow[] = [];
  byDay.forEach((periods, i) => {
    const last = rows.at(-1);
    if (last && JSON.stringify(last.periods) === JSON.stringify(periods))
      last.to = i + 1;
    else rows.push({ from: i + 1, to: i + 1, periods });
  });
  return rows;
}
