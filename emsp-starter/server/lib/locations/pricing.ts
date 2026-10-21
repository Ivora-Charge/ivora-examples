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
 */

export type DisplayComponent = {
  type: TariffDimensionType;
  unit: "kWh" | "hour" | "session";
  /** Per unit, with VAT when the CPO gave the VAT rate. */
  price: number;
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

const fractionDigits = (currency: string) => {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits!;
  } catch {
    return 2;
  }
};

/** A price in its currency: at least the currency's usual decimals, up to 4. */
export function formatMoney(value: number, currency: string): string {
  const digits = fractionDigits(currency);
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: Math.max(digits, 4),
    }).format(value);
  } catch {
    return `${value.toFixed(Math.max(digits, 2))} ${currency}`;
  }
}

const withVat = (c: PriceComponent) =>
  c.vat === undefined ? c.price : c.price * (1 + c.vat / 100);

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
      const price = withVat(c);
      const unit = UNIT[c.type];
      const amount = formatMoney(price, t.currency);
      const text =
        c.type === "FLAT"
          ? `${amount} per session`
          : c.type === "PARKING_TIME"
            ? `${amount} per hour parking`
            : `${amount} per ${unit}`;
      components.push({
        type: c.type,
        unit,
        price,
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
  const main = [...first.values()].filter((c) => c.price > 0);
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
  /** kWh, hours or sessions, after rounding to the step size. */
  quantity: number;
  unitPrice: number;
  amountExclVat: number;
  vat?: number;
};

export type Preview = {
  currency: string;
  lines: PreviewLine[];
  totalExclVat: number;
  /** Null when a component used has no VAT rate and max/min price gives no incl_vat. */
  totalInclVat: number | null;
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

const round = (n: number, digits: number) =>
  Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * What a session would cost under a tariff, minute by minute. An estimate for display:
 * the CDR is what counts. step_size rounds up the last period of each dimension, as
 * OCPI 2.2.1 says, so earlier periods are billed exactly.
 */
export function previewCost(t: Tariff, s: PreviewSession): Preview {
  const chargingMin = Math.max(0, Math.round(s.chargingMinutes));
  const parkingMin = Math.max(0, Math.round(s.parkingMinutes ?? 0));
  const total = Math.min(MAX_PREVIEW_MINUTES, chargingMin + parkingMin);
  const energy = Math.max(0, s.energyKwh);
  const kwhPerMin = chargingMin ? energy / chargingMin : 0;
  const power = s.powerKw ?? (chargingMin ? energy / (chargingMin / 60) : 0);
  const tz = s.timeZone || "UTC";

  // Quantities per (element, dimension), in Wh, seconds or sessions.
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
    kwh: Math.min(energy, kwhPerMin * minute),
    powerKw: charging ? power : 0,
    currentA: charging ? s.currentA : 0,
    seconds: minute * 60,
  });

  add("FLAT", active(t, "FLAT", moment(0, chargingMin > 0)), 1, 0);
  for (let minute = 0; minute < total; minute++) {
    const charging = minute < chargingMin;
    const m = moment(minute, charging);
    if (charging) {
      add("ENERGY", active(t, "ENERGY", m), kwhPerMin * 1000, minute);
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
  const lines: PreviewLine[] = [];
  let excl = 0;
  let incl = 0;
  let vatKnown = true;
  for (const b of buckets.values()) {
    let qty = b.qty;
    if (b.type !== "FLAT" && b.c.step_size > 0 && lastOfType.get(b.type) === b)
      qty = Math.ceil(round(qty, 6) / b.c.step_size) * b.c.step_size;
    const units =
      b.type === "ENERGY" ? qty / 1000 : b.type === "FLAT" ? qty : qty / 3600;
    const amount = units * b.c.price;
    excl += amount;
    incl += amount * (1 + (b.c.vat ?? 0) / 100);
    if (b.c.vat === undefined && amount > 0) vatKnown = false;
    const line: PreviewLine = {
      type: b.type,
      quantity: round(units, 4),
      unitPrice: b.c.price,
      amountExclVat: round(amount, 4),
    };
    if (b.c.vat !== undefined) line.vat = b.c.vat;
    lines.push(line);
  }

  let bounded: Preview["bounded"];
  let inclVat: number | null = vatKnown ? incl : null;
  if (t.min_price && excl < t.min_price.excl_vat) {
    bounded = "min";
    excl = t.min_price.excl_vat;
    inclVat = t.min_price.incl_vat ?? null;
  } else if (t.max_price && excl > t.max_price.excl_vat) {
    bounded = "max";
    excl = t.max_price.excl_vat;
    inclVat = t.max_price.incl_vat ?? null;
  }
  const digits = fractionDigits(t.currency);
  const totalExclVat = round(excl, digits);
  const totalInclVat = inclVat === null ? null : round(inclVat, digits);
  const preview: Preview = {
    currency: t.currency,
    lines,
    totalExclVat,
    totalInclVat,
    text:
      totalInclVat !== null
        ? formatMoney(totalInclVat, t.currency)
        : `${formatMoney(totalExclVat, t.currency)} excl. VAT`,
  };
  if (bounded) preview.bounded = bounded;
  return preview;
}
