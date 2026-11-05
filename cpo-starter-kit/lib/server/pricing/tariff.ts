import "server-only";
import { formatMinor, minorToMajorString } from "@/lib/money";
import type {
  DayOfWeek,
  PriceComponent,
  TariffDefinitionInput,
  TariffElement,
  TariffInput,
} from "../ivora/types";
import type { TariffDefinition, TouPeriod } from "./types";

// From the kit's tariff editor to Ivora's OCPI 2.2.1-aligned elements. Pure functions,
// no I/O. Prices go to Ivora as major units (its OCPI format), converted from integer
// minor units exactly, by string.

export const WEEK: readonly DayOfWeek[] = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];
const SHORT: Record<DayOfWeek, string> = {
  MONDAY: "Mon",
  TUESDAY: "Tue",
  WEDNESDAY: "Wed",
  THURSDAY: "Thu",
  FRIDAY: "Fri",
  SATURDAY: "Sat",
  SUNDAY: "Sun",
};

/**
 * The currency of paid tariffs. Ivora Checkout settles card payments in US dollars,
 * and the hold below is a dollar amount, so paid tariffs are USD only. Free tariffs
 * hold and charge nothing, in any currency.
 */
export const PAID_CURRENCY = "USD";
/**
 * The card hold for a paid tariff: $25.00 in minor units (US cents). The kit's
 * checkout holds this before charging and captures the final bill. Free tariffs hold
 * nothing.
 */
export const PAID_HOLD_MINOR = 2500;

/**
 * The editor's note for a paid tariff in another currency than PAID_CURRENCY, or
 * undefined in that currency. It shows next to the Paid/Free choice and starts the save
 * refusal. `sample` is the demo's wording (its CAD tariff is seeded, not saved).
 */
export function paidCurrencyNote(
  currency: string,
  sample: boolean,
): string | undefined {
  if (currency === PAID_CURRENCY) return undefined;
  return sample
    ? `Paid tariffs can be saved in ${PAID_CURRENCY} only for now; this ${currency} sample shows how other currencies read.`
    : `Paid tariffs can be saved in ${PAID_CURRENCY} only for now; this tariff is in ${currency}, so make it free to save a new version.`;
}
/** Default free idle minutes per session. */
export const DEFAULT_IDLE_GRACE_MINUTES = 10;
export const MAX_PERIODS = 4;

/** Ivora's external_reference for a version: cpo-tariff-<kit tariff ID>-v<n>. */
export const tariffReference = (tariffId: string, version: number) =>
  `cpo-tariff-${tariffId}-v${version}`;

const major = (minor: number, currency: string) =>
  Number(minorToMajorString(minor, currency));

/** "Mon–Fri", "Sat, Sun", "every day". */
export function describeDays(days: readonly DayOfWeek[]): string {
  const idx = WEEK.map((d) => days.includes(d));
  if (idx.every(Boolean)) return "every day";
  const runs: string[] = [];
  for (let i = 0; i < 7; i++) {
    if (!idx[i]) continue;
    let j = i;
    while (j + 1 < 7 && idx[j + 1]) j++;
    runs.push(
      j - i >= 2
        ? `${SHORT[WEEK[i]]}–${SHORT[WEEK[j]]}`
        : WEEK.slice(i, j + 1)
            .map((d) => SHORT[d])
            .join(", "),
    );
    i = j;
  }
  return runs.join(", ");
}

const minutes = (t: string) =>
  Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const WEEK_MINUTES = 7 * 1440;

/**
 * A period's minutes of the week (Monday 00:00 is 0), as [from, to) ranges. Days are
 * the local day at each moment, so an overnight period chosen on Friday covers Friday
 * from its start to midnight and Saturday from midnight to its end (Sunday's runs
 * into Monday).
 */
function weekRanges(p: TouPeriod): [number, number][] {
  const s = minutes(p.start);
  const e = minutes(p.end);
  return p.days.flatMap((d): [number, number][] => {
    const day = WEEK.indexOf(d) * 1440;
    if (s < e) return [[day + s, day + e]];
    const next = (day + 1440) % WEEK_MINUTES;
    return e > 0
      ? [
          [day + s, day + 1440],
          [next, next + e],
        ]
      : [[day + s, day + 1440]];
  });
}

/**
 * Pairs of periods that share a moment of the week, with the day it starts on. The kit
 * refuses them, so each moment has one price. (Ivora also accepts windows nested
 * inside each other; the kit keeps the simpler rule so a tariff reads the same in its
 * editor and on a receipt.)
 */
export function overlappingPeriods(
  periods: TouPeriod[],
): [number, number, DayOfWeek][] {
  const out: [number, number, DayOfWeek][] = [];
  for (let a = 0; a < periods.length; a++)
    for (let b = a + 1; b < periods.length; b++) {
      let first: number | null = null;
      for (const [s1, e1] of weekRanges(periods[a]))
        for (const [s2, e2] of weekRanges(periods[b]))
          if (s1 < e2 && s2 < e1) {
            const at = Math.max(s1, s2);
            first = first === null ? at : Math.min(first, at);
          }
      if (first !== null) out.push([a, b, WEEK[Math.floor(first / 1440)]]);
    }
  return out;
}

/** Each day of the week moved to the next one (Sunday to Monday). */
const nextDays = (days: readonly DayOfWeek[]) =>
  WEEK.filter((d) => days.includes(WEEK[(WEEK.indexOf(d) + 6) % 7]));

/**
 * One period as Ivora elements. Ivora checks day_of_week against the local day of
 * each moment, so an overnight period on chosen days is two elements: its days from
 * the start to midnight, and the following days from midnight to the end (Fri
 * 22:00-06:00 is Fri from 22:00 and Sat until 06:00). Every day, or a period that
 * does not cross midnight, is one element.
 */
function periodElements(p: TouPeriod, currency: string): TariffElement[] {
  const price_components: PriceComponent[] = [
    {
      type: "ENERGY",
      price: major(p.energyMinorPerKwh, currency),
      step_size: 1,
    },
  ];
  const everyDay = p.days.length === 7;
  const overnight = minutes(p.end) < minutes(p.start);
  if (everyDay || !overnight)
    return [
      {
        price_components,
        restrictions: {
          start_time: p.start,
          end_time: p.end,
          ...(everyDay
            ? {}
            : { day_of_week: WEEK.filter((d) => p.days.includes(d)) }),
        },
      },
    ];
  const out: TariffElement[] = [
    {
      price_components,
      restrictions: {
        start_time: p.start,
        day_of_week: WEEK.filter((d) => p.days.includes(d)),
      },
    },
  ];
  if (p.end !== "00:00")
    out.push({
      price_components,
      restrictions: { end_time: p.end, day_of_week: nextDays(p.days) },
    });
  return out;
}

/**
 * Ivora elements, each with the period it prices (null for the base element): the
 * time-of-use periods' ENERGY elements (restricted to their hours and days), then the
 * unrestricted base element with the base ENERGY price, the optional session fee
 * (FLAT) and idle fee (PARKING_TIME per hour, billed per started minute). Ivora takes,
 * per dimension and moment, the first element that applies, so periods go first and
 * the base element prices the rest. A free tariff is one ENERGY element at 0.
 */
export function pricedElements(
  def: TariffDefinition,
): { element: TariffElement; period: number | null }[] {
  const c = def.currency;
  if (def.kind === "free")
    return [
      {
        element: {
          price_components: [{ type: "ENERGY", price: 0, step_size: 1 }],
        },
        period: null,
      },
    ];
  const periods = def.periods.flatMap((p, i) =>
    periodElements(p, c).map((element) => ({ element, period: i })),
  );
  const base: PriceComponent[] = [
    { type: "ENERGY", price: major(def.energyMinorPerKwh, c), step_size: 1 },
  ];
  if (def.sessionFeeMinor)
    base.push({ type: "FLAT", price: major(def.sessionFeeMinor, c) });
  if (def.idleMinorPerMinute)
    base.push({
      type: "PARKING_TIME",
      price: major(def.idleMinorPerMinute * 60, c),
      step_size: 60,
    });
  return [...periods, { element: { price_components: base }, period: null }];
}

export const elementsFor = (def: TariffDefinition): TariffElement[] =>
  pricedElements(def).map((x) => x.element);

/** The free idle minutes Ivora applies (rules.idle_grace_minutes); 0 for none. */
export const graceMinutes = (def: TariffDefinition) =>
  def.kind === "paid" && def.idleMinorPerMinute ? def.idleGraceMinutes : 0;

/**
 * The kit's English description for drivers, for example "$0.35 per kWh; $0.45 per
 * kWh Mon–Fri 16:00–21:00; $1.00 session fee; idle fee $0.40 per minute plugged in
 * but not charging, after the first 10 idle minutes". Idle time is any time plugged
 * in without charging: after charging ends, and while it is paused.
 */
export function generatedDriverText(def: TariffDefinition): string {
  if (def.kind === "free") return "Free charging.";
  const m = (minor: number) => formatMinor(minor, def.currency);
  const parts = [`${m(def.energyMinorPerKwh)} per kWh`];
  for (const p of def.periods)
    parts.push(
      `${m(p.energyMinorPerKwh)} per kWh ${describeDays(p.days)} ${p.start}–${p.end}`,
    );
  if (def.sessionFeeMinor) parts.push(`${m(def.sessionFeeMinor)} session fee`);
  if (def.idleMinorPerMinute)
    parts.push(
      graceMinutes(def)
        ? `idle fee ${m(def.idleMinorPerMinute)} per minute plugged in but not charging, after the first ${def.idleGraceMinutes} idle minutes`
        : `idle fee ${m(def.idleMinorPerMinute)} per minute plugged in but not charging`,
    );
  const text = parts.join("; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}. Times are ${def.timeZone} local time.`;
}

export const driverText = (def: TariffDefinition) =>
  def.driverText ?? generatedDriverText(def);

/** Card hold before charging, in minor units. */
export const holdMinor = (def: TariffDefinition) =>
  def.kind === "free" ? 0 : PAID_HOLD_MINOR;

/**
 * The draft as `POST /tariffs/simulate` takes it. An idle grace period is Ivora's
 * rules.idle_grace_minutes; `withGrace: false` leaves it out (to tell whether a
 * refusal was about the rule).
 */
export function definitionInput(
  def: TariffDefinition,
  { withGrace = true }: { withGrace?: boolean } = {},
): TariffDefinitionInput {
  const grace = withGrace ? graceMinutes(def) : 0;
  return {
    currency: def.currency,
    elements: elementsFor(def),
    tariff_alt_text: [{ language: "en", text: driverText(def).slice(0, 512) }],
    time_zone: def.timeZone,
    ...(grace ? { rules: { idle_grace_minutes: grace } } : {}),
  };
}

/** Whether two definitions charge the same (the driver text aside). */
export function samePrices(a: TariffDefinition, b: TariffDefinition): boolean {
  const key = (d: TariffDefinition) =>
    JSON.stringify([
      d.kind,
      d.currency,
      d.timeZone,
      d.energyMinorPerKwh,
      d.sessionFeeMinor,
      d.idleMinorPerMinute,
      graceMinutes(d),
      d.periods.map((p) => [
        WEEK.filter((x) => p.days.includes(x)),
        p.start,
        p.end,
        p.energyMinorPerKwh,
      ]),
    ]);
  return key(a) === key(b);
}

/** `POST /tariffs` for one version of a kit tariff. */
export function tariffInput(
  def: TariffDefinition,
  tariffId: string,
  version: number,
): TariffInput {
  return {
    ...definitionInput(def),
    authorization_minor: holdMinor(def),
    external_reference: tariffReference(tariffId, version),
  };
}

/** A short line for lists: "Paid · $0.35 per kWh · 2 periods · idle fee". */
export function summary(def: TariffDefinition): string {
  if (def.kind === "free") return "Free";
  const parts = [`${formatMinor(def.energyMinorPerKwh, def.currency)} per kWh`];
  if (def.periods.length)
    parts.push(
      `${def.periods.length} time-of-use ${def.periods.length === 1 ? "period" : "periods"}`,
    );
  if (def.sessionFeeMinor)
    parts.push(`${formatMinor(def.sessionFeeMinor, def.currency)} session fee`);
  if (def.idleMinorPerMinute)
    parts.push(
      graceMinutes(def)
        ? `idle fee ${formatMinor(def.idleMinorPerMinute, def.currency)}/min after ${def.idleGraceMinutes} min`
        : `idle fee ${formatMinor(def.idleMinorPerMinute, def.currency)}/min`,
    );
  return parts.join(" · ");
}
