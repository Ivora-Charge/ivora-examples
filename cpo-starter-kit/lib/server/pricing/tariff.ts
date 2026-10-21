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
 * The card hold for a paid tariff, in minor units: $25 in USD (the kit's checkout
 * holds this before charging and captures the final bill). Free tariffs hold nothing.
 */
export const PAID_HOLD_MINOR = 2500;
/** Default free idle minutes after charging ends. */
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

/** A period's local minutes of the day, as [from, to) ranges (split at midnight). */
function ranges(p: TouPeriod): [number, number][] {
  const s = minutes(p.start);
  const e = minutes(p.end);
  return s < e
    ? [[s, e]]
    : [
        [s, 1440],
        [0, e],
      ];
}

/**
 * Pairs of periods that share a day and a time. The kit refuses them, so each moment
 * has one price. (Ivora also accepts windows nested inside each other; the kit keeps
 * the simpler rule so a tariff reads the same in its editor and on a receipt.)
 */
export function overlappingPeriods(periods: TouPeriod[]): [number, number][] {
  const out: [number, number][] = [];
  for (let a = 0; a < periods.length; a++)
    for (let b = a + 1; b < periods.length; b++) {
      if (!periods[a].days.some((d) => periods[b].days.includes(d))) continue;
      const hit = ranges(periods[a]).some(([s1, e1]) =>
        ranges(periods[b]).some(([s2, e2]) => s1 < e2 && s2 < e1),
      );
      if (hit) out.push([a, b]);
    }
  return out;
}

/**
 * Ivora elements: one ENERGY element per time-of-use period (restricted to its hours
 * and days), then the unrestricted base element with the base ENERGY price, the
 * optional session fee (FLAT) and idle fee (PARKING_TIME per hour, billed per started
 * minute). Ivora takes, per dimension and moment, the first element that applies, so
 * periods go first and the base element prices the rest. A free tariff is one ENERGY
 * element at 0.
 */
export function elementsFor(def: TariffDefinition): TariffElement[] {
  const c = def.currency;
  if (def.kind === "free")
    return [{ price_components: [{ type: "ENERGY", price: 0, step_size: 1 }] }];
  const periods: TariffElement[] = def.periods.map((p) => ({
    price_components: [
      { type: "ENERGY", price: major(p.energyMinorPerKwh, c), step_size: 1 },
    ],
    restrictions: {
      start_time: p.start,
      end_time: p.end,
      ...(p.days.length < 7
        ? { day_of_week: WEEK.filter((d) => p.days.includes(d)) }
        : {}),
    },
  }));
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
  return [...periods, { price_components: base }];
}

/**
 * The kit's English description for drivers, for example "$0.35 per kWh; $0.45 per
 * kWh Mon–Fri 16:00–21:00; $1.00 session fee; idle fee $0.40 per minute after the
 * first 10 minutes once charging ends". It names the idle grace, which Ivora's own
 * generated text can't know (the grace is applied by the kit, see README).
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
      def.idleGraceMinutes
        ? `idle fee ${m(def.idleMinorPerMinute)} per minute after the first ${def.idleGraceMinutes} minutes once charging ends`
        : `idle fee ${m(def.idleMinorPerMinute)} per minute once charging ends`,
    );
  const text = parts.join("; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}. Times are ${def.timeZone} local time.`;
}

export const driverText = (def: TariffDefinition) =>
  def.driverText ?? generatedDriverText(def);

/** Card hold before charging, in minor units. */
export const holdMinor = (def: TariffDefinition) =>
  def.kind === "free" ? 0 : PAID_HOLD_MINOR;

/** The draft as `POST /tariffs/simulate` takes it. */
export function definitionInput(def: TariffDefinition): TariffDefinitionInput {
  return {
    currency: def.currency,
    elements: elementsFor(def),
    tariff_alt_text: [{ language: "en", text: driverText(def).slice(0, 512) }],
    time_zone: def.timeZone,
  };
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
      `idle fee ${formatMinor(def.idleMinorPerMinute, def.currency)}/min after ${def.idleGraceMinutes} min`,
    );
  return parts.join(" · ");
}
