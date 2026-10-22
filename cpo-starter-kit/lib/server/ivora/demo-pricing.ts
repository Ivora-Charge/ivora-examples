import "server-only";
import { currencyExponent } from "@/lib/money";
import { IvoraError } from "./errors";
import type {
  DayOfWeek,
  PriceComponent,
  PriceDimension,
  Quote,
  QuoteLine,
  SessionProfile,
  TariffDefinitionInput,
  TariffElement,
} from "./types";

// Demo mode's stand-in for `POST /tariffs/simulate`, so the pricing preview works
// offline. It prices what the kit's editor builds (ENERGY, FLAT and PARKING_TIME, with
// time-of-day and day-of-week restrictions, and the idle_grace_minutes rule) by the
// documented rules: for each minute the first element whose restrictions hold prices
// each dimension, FLAT is charged by the first element with FLAT that applies at the
// start, the first idle minutes of rules.idle_grace_minutes are free (reported as
// idle_free_seconds), amounts stay exact and the total is rounded half up once. Live
// mode always asks Ivora; this never runs there.

const MAX_MINUTES = 10_080;

const invalid = (message: string) =>
  new IvoraError(422, "tariff_invalid", message, undefined, undefined, {
    errors: [{ message }],
  });

/** HH:MM to minutes after midnight. */
const hm = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Local minute of the day and weekday of an instant in a time zone. */
function localClock(zone: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (ms: number) => {
    const p = Object.fromEntries(
      f.formatToParts(ms).map((x) => [x.type, x.value]),
    );
    return {
      minute: Number(p.hour) * 60 + Number(p.minute),
      day: p.weekday.toUpperCase() as DayOfWeek,
    };
  };
}

function applies(
  e: TariffElement,
  at: { minute: number; day: DayOfWeek },
): boolean {
  const r = e.restrictions;
  if (!r) return true;
  if (r.day_of_week && !r.day_of_week.includes(at.day)) return false;
  const s = r.start_time ? hm(r.start_time) : null;
  const end = r.end_time ? hm(r.end_time) : null;
  if (s !== null && end !== null)
    return s < end
      ? at.minute >= s && at.minute < end
      : at.minute >= s || at.minute < end;
  if (s !== null) return at.minute >= s;
  if (end !== null) return at.minute < end;
  return true;
}

/** Major units (at most 4 decimals) to ten-thousandths, as an integer. */
function e4(price: number): bigint {
  const [w, f = ""] = String(price).split(".");
  if (f.length > 4) throw invalid("Prices have at most 4 decimal places.");
  return BigInt(w) * 10_000n + BigInt(f.padEnd(4, "0"));
}

const roundHalfUp = (n: bigint, d: bigint) => (2n * n + d) / (2n * d);

/** n/d as a decimal string with 6 places, rounded half up. */
function decimal(n: bigint, d: bigint): string {
  const micro = roundHalfUp(n * 1_000_000n, d);
  return `${micro / 1_000_000n}.${String(micro % 1_000_000n).padStart(6, "0")}`;
}

function check(t: TariffDefinitionInput) {
  if (!t.elements.length) throw invalid("A tariff needs at least one element.");
  for (const k of Object.keys(t.rules ?? {}))
    if (k !== "idle_grace_minutes")
      throw invalid(`Demo mode does not price the ${k} rule.`);
  const grace = t.rules?.idle_grace_minutes;
  if (
    grace !== undefined &&
    (!Number.isInteger(grace) || grace < 0 || grace > 1440)
  )
    throw invalid(
      "idle_grace_minutes is a whole number of minutes from 0 to 1440.",
    );
  for (const e of t.elements) {
    const r = e.restrictions ?? {};
    for (const k of Object.keys(r))
      if (!["start_time", "end_time", "day_of_week"].includes(k))
        throw invalid(`Demo mode does not price the ${k} restriction.`);
    if (r.start_time && r.start_time === r.end_time)
      throw invalid("A time window needs different start and end times.");
    const seen = new Set<PriceDimension>();
    for (const c of e.price_components) {
      if (c.type === "TIME")
        throw invalid("Demo mode does not price charging time (TIME).");
      if (seen.has(c.type)) throw invalid(`An element prices ${c.type} twice.`);
      seen.add(c.type);
    }
  }
}

/** The demo simulation: same request and answer shapes as the API. */
export function demoSimulate(
  t: TariffDefinitionInput,
  s: SessionProfile,
): Quote {
  check(t);
  const startMs = Date.parse(s.start_at);
  if (Number.isNaN(startMs)) throw invalid("start_at is not a date.");
  const duration = Math.round(s.duration_minutes);
  const idle = Math.round(s.idle_minutes);
  if (duration < 0 || idle < 0 || duration + idle > MAX_MINUTES)
    throw invalid("The session is too long to price.");
  const wh = BigInt(Math.round(s.energy_kwh * 1000));
  const clock = localClock(s.time_zone || t.time_zone || "UTC");
  const minor = 10n ** BigInt(currencyExponent(t.currency));

  const first = (type: PriceDimension, ms: number) => {
    const at = clock(ms);
    for (const [i, e] of t.elements.entries()) {
      const c = e.price_components.find((x) => x.type === type);
      if (c && applies(e, at)) return { i, c };
    }
    return null;
  };

  // Charging minutes per ENERGY element, and idle minutes per PARKING_TIME element.
  const charged = new Map<number, { c: PriceComponent; n: bigint }>();
  const span = Math.max(1, duration);
  for (let m = 0; m < span; m++) {
    const hit = first("ENERGY", startMs + m * 60_000);
    if (!hit) continue;
    const x = charged.get(hit.i) ?? { c: hit.c, n: 0n };
    x.n += 1n;
    charged.set(hit.i, x);
  }
  const parked = new Map<number, { c: PriceComponent; n: bigint }>();
  const grace = t.rules?.idle_grace_minutes;
  const free = Math.min(idle, grace ?? 0);
  for (let m = free; m < idle; m++) {
    const hit = first("PARKING_TIME", startMs + (duration + m) * 60_000);
    if (!hit) continue;
    const x = parked.get(hit.i) ?? { c: hit.c, n: 0n };
    x.n += 1n;
    parked.set(hit.i, x);
  }

  // Every amount over one denominator (minor units), so the sum stays exact.
  const D = BigInt(span) * 1000n * 10_000n * 60n;
  const lines: (QuoteLine & { num: bigint })[] = [];
  const unitPrice = (c: PriceComponent) =>
    decimal(e4(c.price) * minor, 10_000n);
  for (const [i, { c, n }] of charged) {
    const num = wh * n * e4(c.price) * minor * 60n;
    lines.push({
      type: "ENERGY",
      element: i,
      reservation: false,
      quantity: decimal(wh * n, BigInt(span) * 1000n),
      unit: "kWh",
      price_minor: unitPrice(c),
      exact_minor: decimal(num, D),
      amount_minor: Number(roundHalfUp(num, D)),
      num,
    });
  }
  const flat = first("FLAT", startMs);
  if (flat) {
    const num = (e4(flat.c.price) * minor * D) / 10_000n;
    lines.push({
      type: "FLAT",
      element: flat.i,
      reservation: false,
      quantity: "1",
      unit: "session",
      price_minor: unitPrice(flat.c),
      exact_minor: decimal(num, D),
      amount_minor: Number(roundHalfUp(num, D)),
      num,
    });
  }
  for (const [i, { c, n }] of parked) {
    // Per hour, billed per started step (the kit uses whole minutes).
    const step = BigInt(Math.max(60, c.step_size ?? 60) / 60);
    const minutes = ((n + step - 1n) / step) * step;
    const num = (minutes * e4(c.price) * minor * D) / (60n * 10_000n);
    lines.push({
      type: "PARKING_TIME",
      element: i,
      reservation: false,
      quantity: decimal(minutes, 60n),
      unit: "h",
      price_minor: unitPrice(c),
      exact_minor: decimal(num, D),
      amount_minor: Number(roundHalfUp(num, D)),
      num,
    });
  }
  const sum = lines.reduce((a, l) => a + l.num, 0n);
  const total = Number(roundHalfUp(sum, D));
  return {
    tariff_id: null,
    currency: t.currency,
    pricing_version: "elements-v1",
    lines: lines.map(({ num: _num, ...l }) => l),
    subtotal_minor: total,
    exact_subtotal_minor: decimal(sum, D),
    adjustments: [],
    total_minor: total,
    tariff_alt_text: t.tariff_alt_text,
    ...(grace !== undefined ? { idle_free_seconds: free * 60 } : {}),
  };
}
