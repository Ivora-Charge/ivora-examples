import { dateTimeMs } from "@/lib/ocpi/locations";
import {
  DAYS_OF_WEEK,
  type PriceComponent,
  type Tariff,
  type TariffDimensionType,
  type TariffElement,
  type TariffRestrictions,
} from "@/lib/ocpi/tariffs";

/**
 * Tariffs as drivers see them: a display price per tariff, and a preview of what a
 * session would cost. DISPLAY ONLY. What a driver pays is settled from the CDR (a later
 * part), and an eMSP may add its own fees on top of the CPO's tariff.
 *
 * OCPI 2.2.1 rules followed here: prices exclude VAT (`vat` is a percentage); for each
 * dimension (ENERGY, TIME, PARKING_TIME, FLAT) the first element whose restrictions
 * match is the one that applies; restriction times are local to the location; min
 * values are inclusive and max values exclusive; a tariff's min_price and max_price
 * bound the total.
 *
 * Money is computed in integers, never floating point (docs/conventions.md):
 * - Tariff prices are OCPI numbers with at most 4 decimals. They are read as integer
 *   ten-thousandths of the currency's major unit, "E4": €0.4235 is 4235. VAT rates
 *   are read the same way, as ten-thousandths of a percent.
 * - A preview keeps each line's amount as an exact fraction and sums them exactly.
 *   It rounds once, half up, when it turns the total into the currency's minor units
 *   (cents for EUR, none for JPY). Line amounts are rounded the same way for display only.
 */

export type DisplayComponent = {
  type: TariffDimensionType;
  unit: "kWh" | "hour" | "session";
  /**
   * Per unit, in ten-thousandths of the currency's major unit (4235 is €0.4235), with
   * VAT when the CPO gave the VAT rate, rounded half up to that precision.
   */
  priceE4: number;
  vatIncluded: boolean;
  /** For example "€0.35 per kWh". */
  text: string;
  /** When it applies, for example ["Mon–Fri", "08:00–20:00"]. Empty: always. */
  conditions: string[];
};

export type DisplayPrice = {
  tariffId: string;
  currency: string;
  type?: Tariff["type"];
  free: boolean;
  components: DisplayComponent[];
  minPrice?: string;
  maxPrice?: string;
  /** The CPO's own description, when it gave one. */
  altText?: string;
  /** One line, for example "€0.35 per kWh + €1.00 per session". */
  summary: string;
};

const UNIT: Record<TariffDimensionType, DisplayComponent["unit"]> = {
  ENERGY: "kWh",
  TIME: "hour",
  PARKING_TIME: "hour",
  FLAT: "session",
};

/** Digits of a currency's minor unit, from Intl: 2 for CAD, 0 for JPY, 3 for KWD. */
export const fractionDigits = (currency: string) => {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits!;
  } catch {
    return 2;
  }
};

/** A number with at most 4 decimals (an OCPI price or VAT rate), in ten-thousandths. */
export const toE4 = (n: number): bigint => BigInt(Math.round(n * 10_000));

/** 100% in ten-thousandths of a percent: VAT factors are (VAT_100 + vat) / VAT_100. */
const VAT_100 = 1_000_000n;
const vatFactor = (vat: number | undefined) => VAT_100 + toE4(vat ?? 0);

/** n / d rounded half up (away from zero), d > 0. */
export function divRound(n: bigint, d: bigint): bigint {
  return n < 0n ? -divRound(-n, d) : (2n * n + d) / (2n * d);
}

const pow10 = (n: number) => 10n ** BigInt(n);

/** `units` of 10^-scale of the major unit, as an exact decimal string: (4235, 4) is "0.4235". */
function decimal(units: bigint, scale: number): string {
  const neg = units < 0n;
  const digits = (neg ? -units : units).toString().padStart(scale + 1, "0");
  const s = scale
    ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
    : digits;
  return neg ? `-${s}` : s;
}

/**
 * `units` of 10^-scale of the currency's major unit, formatted with at least the
 * currency's usual decimals. Formats the exact decimal: no floating point.
 */
export function formatUnits(
  units: bigint,
  scale: number,
  currency: string,
): string {
  const digits = fractionDigits(currency);
  const value = decimal(units, scale);
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: Math.max(digits, scale),
    }).format(value as Intl.StringNumericLiteral);
  } catch {
    return `${value} ${currency}`;
  }
}

/** An OCPI price (at most 4 decimals) in its currency: at least the currency's usual decimals. */
export function formatMoney(value: number, currency: string): string {
  return formatUnits(toE4(value), 4, currency);
}

/** Integer minor units in their currency: 1235 CAD is "CA$12.35", 1350 JPY is "¥1,350". */
export function formatMinorAmount(minor: number, currency: string): string {
  return formatUnits(BigInt(minor), fractionDigits(currency), currency);
}

/** A component's price per unit in E4, with VAT when the CPO gave the rate. */
const withVatE4 = (c: PriceComponent): bigint =>
  c.vat === undefined
    ? toE4(c.price)
    : divRound(toE4(c.price) * vatFactor(c.vat), VAT_100);

const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function days(list: TariffRestrictions["day_of_week"]): string | undefined {
  if (!list?.length || list.length === 7) return undefined;
  const idx = [...new Set(list.map((d) => DAYS_OF_WEEK.indexOf(d)))].sort();
  const runs: number[][] = [];
  for (const i of idx) {
    const last = runs.at(-1);
    if (last && last.at(-1) === i - 1) last.push(i);
    else runs.push([i]);
  }
  return runs
    .map((r) =>
      r.length >= 3
        ? `${DAY_SHORT[r[0]]}–${DAY_SHORT[r.at(-1)!]}`
        : r.map((i) => DAY_SHORT[i]).join(", "),
    )
    .join(", ");
}

function duration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

function range(
  min: number | undefined,
  max: number | undefined,
  fmt: (n: number) => string,
  words: { min: (s: string) => string; max: (s: string) => string },
): string | undefined {
  if (min !== undefined && max !== undefined)
    return `${fmt(min)} to ${fmt(max)}`;
  if (min !== undefined) return words.min(fmt(min));
  if (max !== undefined) return words.max(fmt(max));
  return undefined;
}

/** Restrictions in words, for example ["Mon–Fri", "08:00–20:00", "after 2 h"]. */
export function describeRestrictions(r: TariffRestrictions = {}): string[] {
  const out: (string | undefined)[] = [
    days(r.day_of_week),
    r.start_time && r.end_time
      ? `${r.start_time}–${r.end_time}`
      : r.start_time
        ? `from ${r.start_time}`
        : r.end_time
          ? `until ${r.end_time}`
          : undefined,
    r.start_date ? `from ${r.start_date}` : undefined,
    r.end_date ? `before ${r.end_date}` : undefined,
    range(r.min_duration, r.max_duration, duration, {
      min: (x) => `after ${x}`,
      max: (x) => `first ${x}`,
    }),
    range(r.min_kwh, r.max_kwh, (n) => `${n} kWh`, {
      min: (x) => `from ${x}`,
      max: (x) => `up to ${x}`,
    }),
    range(r.min_power, r.max_power, (n) => `${n} kW`, {
      min: (x) => `at ${x} or more`,
      max: (x) => `below ${x}`,
    }),
    range(r.min_current, r.max_current, (n) => `${n} A`, {
      min: (x) => `at ${x} or more`,
      max: (x) => `below ${x}`,
    }),
    r.reservation === "RESERVATION"
      ? "while reserved"
      : r.reservation === "RESERVATION_EXPIRES"
        ? "when a reservation expires"
        : undefined,
  ];
  return out.filter((s): s is string => !!s);
}

const restricted = (e: TariffElement) =>
  !!e.restrictions && Object.keys(e.restrictions).length > 0;

/** Every component is free and there is no minimum price. */
export function isFreeTariff(t: Tariff): boolean {
  return (
    t.elements.every((e) => e.price_components.every((c) => c.price === 0)) &&
    !(t.min_price && t.min_price.excl_vat > 0)
  );
}

/** Within start_date_time and end_date_time, if the tariff has them. */
export function tariffActive(t: Tariff, now = new Date()): boolean {
  const ms = now.getTime();
  if (t.start_date_time && dateTimeMs(t.start_date_time) > ms) return false;
  if (t.end_date_time && dateTimeMs(t.end_date_time) <= ms) return false;
  return true;
}

/**
 * The tariff a driver of this eMSP sees for a connector, from its tariff_ids: the first
 * active REGULAR (or untyped) one, else the first active one. Charging-preference
 * profiles and ad-hoc payment tariffs are for other cases.
 */
export function primaryTariff(
  tariffIds: string[] | undefined,
  tariffs: Tariff[],
  now = new Date(),
): Tariff | undefined {
  const candidates = (tariffIds ?? [])
    .map((id) => tariffs.find((t) => t.id === id))
    .filter((t): t is Tariff => !!t && tariffActive(t, now));
  return (
    candidates.find((t) => !t.type || t.type === "REGULAR") ?? candidates[0]
  );
}

function money(p: { excl_vat: number; incl_vat?: number }, currency: string) {
  return p.incl_vat !== undefined
    ? formatMoney(p.incl_vat, currency)
    : `${formatMoney(p.excl_vat, currency)} excl. VAT`;
}

export function displayPrice(t: Tariff, language = "en"): DisplayPrice {
  const components: DisplayComponent[] = [];
  const seenRestricted = new Set<TariffDimensionType>();
  for (const e of t.elements) {
    const conditions = describeRestrictions(e.restrictions);
    for (const c of e.price_components) {
      const priceE4 = withVatE4(c);
      const unit = UNIT[c.type];
      const amount = formatUnits(priceE4, 4, t.currency);
      const text =
        c.type === "FLAT"
          ? `${amount} per session`
          : c.type === "PARKING_TIME"
            ? `${amount} per hour parking`
            : `${amount} per ${unit}`;
      components.push({
        type: c.type,
        unit,
        priceE4: Number(priceE4),
        vatIncluded: c.vat !== undefined,
        text: c.vat === undefined ? `${text} excl. VAT` : text,
        // After a restricted element, an unrestricted one is the fallback.
        conditions:
          !restricted(e) && seenRestricted.has(c.type)
            ? ["otherwise"]
            : conditions,
      });
      if (restricted(e)) seenRestricted.add(c.type);
    }
  }
  const free = isFreeTariff(t);
  // The first component of each dimension, with its conditions; more of the same
  // dimension (other times, other tiers) make the price vary.
  const first = new Map<TariffDimensionType, DisplayComponent>();
  for (const c of components) if (!first.has(c.type)) first.set(c.type, c);
  const main = [...first.values()].filter((c) => c.priceE4 > 0);
  const varies = first.size < components.length;
  const line = main
    .map((c) =>
      c.conditions.length ? `${c.text} (${c.conditions.join(", ")})` : c.text,
    )
    .join(" + ");
  const altText =
    t.tariff_alt_text?.find((x) => x.language === language)?.text ??
    t.tariff_alt_text?.[0]?.text;
  const value: DisplayPrice = {
    tariffId: t.id,
    currency: t.currency,
    free,
    components,
    summary: free
      ? "Free"
      : `${line || "Price varies"}${varies && line ? "; varies at other times" : ""}`,
  };
  if (t.type) value.type = t.type;
  if (t.min_price) value.minPrice = money(t.min_price, t.currency);
  if (t.max_price) value.maxPrice = money(t.max_price, t.currency);
  if (altText) value.altText = altText;
  return value;
}

export type PreviewSession = {
  /** When charging starts. */
  start: Date;
  energyKwh: number;
  chargingMinutes: number;
  /** Minutes plugged in after charging stopped. */
  parkingMinutes?: number;
  /** Average charging power. Default: energy over charging time. */
  powerKw?: number;
  /** Charging current, for tariffs restricted by current. Unknown: those restrictions are ignored. */
  currentA?: number;
  /** IANA time zone of the location. Default UTC. */
  timeZone?: string;
};

export type PreviewLine = {
  type: TariffDimensionType;
  /** kWh, hours or sessions, after rounding to the step size. For display. */
  quantity: number;
  /** Excluding VAT, in ten-thousandths of the major unit (5900 is €0.59). */
  unitPriceE4: number;
  /**
   * Excluding VAT, in minor units, rounded half up for display. The total is summed
   * from the exact line amounts, so lines may not add up to it to the last minor unit.
   */
  amountExclVatMinor: number;
  /** VAT rate in percent, when the CPO gave one. */
  vat?: number;
};

export type Preview = {
  currency: string;
  /** Decimals of the currency's minor unit: 2 for EUR (cents), 0 for JPY. */
  minorDigits: number;
  lines: PreviewLine[];
  /** In minor units (cents), rounded once, half up, from the exact sum. */
  totalExclVatMinor: number;
  /**
   * In minor units. Null when a component used has no VAT rate and max/min price gives
   * no incl_vat.
   */
  totalInclVatMinor: number | null;
  /** "min" or "max" when min_price or max_price changed the total. */
  bounded?: "min" | "max";
  /** For example "€7.40". */
  text: string;
};

const MAX_PREVIEW_MINUTES = 7 * 24 * 60;

const formatter = (timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
  });
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Local time of day (minutes), date and weekday. An unknown time zone reads as UTC. */
function localParts(date: Date, timeZone: string) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    try {
      fmt = formatter(timeZone);
    } catch {
      fmt = formatter("UTC");
    }
    formatters.set(timeZone, fmt);
  }
  const p = Object.fromEntries(
    fmt.formatToParts(date).map((x) => [x.type, x.value]),
  );
  return {
    minutes: Number(p.hour) * 60 + Number(p.minute),
    date: `${p.year}-${p.month}-${p.day}`,
    day: p.weekday.toUpperCase(),
  };
}

const hhmm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

type Moment = {
  minutes: number;
  date: string;
  day: string;
  /** kWh charged so far in the session. */
  kwh: number;
  /** kW, 0 while parking. */
  powerKw: number;
  currentA?: number;
  /** Seconds since the session started. */
  seconds: number;
};

/** Whether an element's restrictions hold at this moment of the session. */
export function restrictionsMatch(
  r: TariffRestrictions | undefined,
  m: Moment,
): boolean {
  if (!r) return true;
  if (r.reservation) return false; // previews never include a reservation
  if (r.start_time !== undefined || r.end_time !== undefined) {
    const s = r.start_time !== undefined ? hhmm(r.start_time) : undefined;
    const e = r.end_time !== undefined ? hhmm(r.end_time) : undefined;
    if (s !== undefined && e !== undefined) {
      // end before start: the period runs past midnight.
      const inside =
        s <= e
          ? m.minutes >= s && m.minutes < e
          : m.minutes >= s || m.minutes < e;
      if (s !== e && !inside) return false;
    } else if (s !== undefined && m.minutes < s) return false;
    else if (e !== undefined && m.minutes >= e) return false;
  }
  if (r.start_date && m.date < r.start_date) return false;
  if (r.end_date && m.date >= r.end_date) return false;
  if (r.min_kwh !== undefined && m.kwh < r.min_kwh) return false;
  if (r.max_kwh !== undefined && m.kwh >= r.max_kwh) return false;
  if (r.min_power !== undefined && m.powerKw < r.min_power) return false;
  if (r.max_power !== undefined && m.powerKw >= r.max_power) return false;
  if (m.currentA !== undefined) {
    if (r.min_current !== undefined && m.currentA < r.min_current) return false;
    if (r.max_current !== undefined && m.currentA >= r.max_current)
      return false;
  }
  if (r.min_duration !== undefined && m.seconds < r.min_duration) return false;
  if (r.max_duration !== undefined && m.seconds >= r.max_duration) return false;
  if (r.day_of_week?.length && !r.day_of_week.includes(m.day as never))
    return false;
  return true;
}

/** The element and component that price `type` at this moment. */
function active(t: Tariff, type: TariffDimensionType, m: Moment) {
  for (let i = 0; i < t.elements.length; i++) {
    const e = t.elements[i];
    const c = e.price_components.find((x) => x.type === type);
    if (c && restrictionsMatch(e.restrictions, m)) return { index: i, c };
  }
  return undefined;
}

/** Line amounts are exact fractions of E4 units over this: lcm(1000 Wh, 3600 s). */
const LINE_DEN = 18_000n;

/** The exact amount, in E4 units times LINE_DEN, of `qty` Wh, seconds or sessions. */
function lineAmount(type: TariffDimensionType, priceE4: bigint, qty: number) {
  const q = BigInt(qty);
  if (type === "ENERGY") return priceE4 * q * (LINE_DEN / 1000n);
  if (type === "FLAT") return priceE4 * q * LINE_DEN;
  return priceE4 * q * (LINE_DEN / 3600n);
}

/**
 * What a session would cost under a tariff, minute by minute. An estimate for display:
 * the CDR is what counts. step_size rounds up the last period of each dimension, as
 * OCPI 2.2.1 says, so earlier periods are billed exactly. Quantities are whole Wh and
 * seconds; amounts are exact until the total is rounded once to minor units.
 */
export function previewCost(t: Tariff, s: PreviewSession): Preview {
  const chargingMin = Math.max(0, Math.round(s.chargingMinutes));
  const parkingMin = Math.max(0, Math.round(s.parkingMinutes ?? 0));
  const total = Math.min(MAX_PREVIEW_MINUTES, chargingMin + parkingMin);
  const energyWh = Math.max(0, Math.round(s.energyKwh * 1000));
  /** Wh charged by the start of `minute`, spread evenly over the charging time. */
  const whAt = (minute: number) =>
    chargingMin
      ? Math.floor((energyWh * Math.min(minute, chargingMin)) / chargingMin)
      : 0;
  const power =
    s.powerKw ?? (chargingMin ? energyWh / 1000 / (chargingMin / 60) : 0);
  const tz = s.timeZone || "UTC";

  // Quantities per (element, dimension), in whole Wh, seconds or sessions.
  type Bucket = {
    type: TariffDimensionType;
    c: PriceComponent;
    qty: number;
    last: number;
  };
  const buckets = new Map<string, Bucket>();
  const add = (
    type: TariffDimensionType,
    hit: { index: number; c: PriceComponent } | undefined,
    qty: number,
    minute: number,
  ) => {
    if (!hit) return;
    const k = `${hit.index}:${type}`;
    const b = buckets.get(k) ?? { type, c: hit.c, qty: 0, last: minute };
    b.qty += qty;
    b.last = minute;
    buckets.set(k, b);
  };
  const moment = (minute: number, charging: boolean): Moment => ({
    ...localParts(new Date(s.start.getTime() + minute * 60_000), tz),
    kwh: whAt(minute) / 1000,
    powerKw: charging ? power : 0,
    currentA: charging ? s.currentA : 0,
    seconds: minute * 60,
  });

  add("FLAT", active(t, "FLAT", moment(0, chargingMin > 0)), 1, 0);
  for (let minute = 0; minute < total; minute++) {
    const charging = minute < chargingMin;
    const m = moment(minute, charging);
    if (charging) {
      add(
        "ENERGY",
        active(t, "ENERGY", m),
        whAt(minute + 1) - whAt(minute),
        minute,
      );
      add("TIME", active(t, "TIME", m), 60, minute);
    } else {
      add("PARKING_TIME", active(t, "PARKING_TIME", m), 60, minute);
    }
  }

  const lastOfType = new Map<TariffDimensionType, Bucket>();
  for (const b of buckets.values()) {
    const cur = lastOfType.get(b.type);
    if (!cur || b.last >= cur.last) lastOfType.set(b.type, b);
  }
  const digits = fractionDigits(t.currency);
  /** An exact amount over `den` E4 units, rounded half up to minor units. */
  const toMinor = (n: bigint, den: bigint) =>
    Number(divRound(n * pow10(digits), den * 10_000n));

  const lines: PreviewLine[] = [];
  let excl = 0n; // over LINE_DEN
  let incl: bigint | null = 0n; // over LINE_DEN * VAT_100
  for (const b of buckets.values()) {
    let qty = b.qty;
    const step = Math.round(b.c.step_size);
    if (b.type !== "FLAT" && step > 0 && lastOfType.get(b.type) === b)
      qty = Math.ceil(qty / step) * step;
    const priceE4 = toE4(b.c.price);
    const amount = lineAmount(b.type, priceE4, qty);
    excl += amount;
    if (b.c.vat === undefined) {
      if (amount > 0n) incl = null;
    } else if (incl !== null) incl += amount * vatFactor(b.c.vat);
    const quantity =
      b.type === "ENERGY" ? qty / 1000 : b.type === "FLAT" ? qty : qty / 3600;
    const line: PreviewLine = {
      type: b.type,
      quantity: Math.round(quantity * 10_000) / 10_000,
      unitPriceE4: Number(priceE4),
      amountExclVatMinor: toMinor(amount, LINE_DEN),
    };
    if (b.c.vat !== undefined) line.vat = b.c.vat;
    lines.push(line);
  }

  let bounded: Preview["bounded"];
  const bound = (p: { excl_vat: number; incl_vat?: number }) => {
    excl = toE4(p.excl_vat) * LINE_DEN;
    incl =
      p.incl_vat === undefined ? null : toE4(p.incl_vat) * LINE_DEN * VAT_100;
  };
  if (t.min_price && excl < toE4(t.min_price.excl_vat) * LINE_DEN) {
    bounded = "min";
    bound(t.min_price);
  } else if (t.max_price && excl > toE4(t.max_price.excl_vat) * LINE_DEN) {
    bounded = "max";
    bound(t.max_price);
  }
  // The one rounding of the total, to minor units.
  const totalExclVatMinor = toMinor(excl, LINE_DEN);
  const totalInclVatMinor =
    incl === null ? null : toMinor(incl, LINE_DEN * VAT_100);
  const preview: Preview = {
    currency: t.currency,
    minorDigits: digits,
    lines,
    totalExclVatMinor,
    totalInclVatMinor,
    text:
      totalInclVatMinor !== null
        ? formatUnits(BigInt(totalInclVatMinor), digits, t.currency)
        : `${formatUnits(BigInt(totalExclVatMinor), digits, t.currency)} excl. VAT`,
  };
  if (bounded) preview.bounded = bounded;
  return preview;
}
