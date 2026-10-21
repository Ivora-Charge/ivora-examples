import {
  dateTime,
  displayTexts,
  int,
  oneOf,
  type DisplayText,
} from "./locations";
import {
  array,
  COUNTRY,
  done,
  object,
  optional,
  PARTY,
  str,
  url,
  type Ctx,
  type Parsed,
} from "./schema";

/** OCPI 2.2.1 Tariffs module objects (section 11) and their validator. */

export const TARIFF_TYPES = [
  "AD_HOC_PAYMENT",
  "PROFILE_CHEAP",
  "PROFILE_FAST",
  "PROFILE_GREEN",
  "REGULAR",
] as const;
export type TariffType = (typeof TARIFF_TYPES)[number];

export const DIMENSION_TYPES = [
  "ENERGY",
  "FLAT",
  "PARKING_TIME",
  "TIME",
] as const;
export type TariffDimensionType = (typeof DIMENSION_TYPES)[number];

export const DAYS_OF_WEEK = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;
export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];

const RESERVATION_TYPES = ["RESERVATION", "RESERVATION_EXPIRES"] as const;

export type Price = { excl_vat: number; incl_vat?: number };

export type PriceComponent = {
  type: TariffDimensionType;
  /** Price per unit, excluding VAT: per kWh, per hour, or per session for FLAT. */
  price: number;
  /** VAT percentage. Absent when the CPO does not say. */
  vat?: number;
  /** Billing step: Wh for ENERGY, seconds for TIME and PARKING_TIME, 1 for FLAT. */
  step_size: number;
};

export type TariffRestrictions = {
  start_time?: string;
  end_time?: string;
  start_date?: string;
  end_date?: string;
  min_kwh?: number;
  max_kwh?: number;
  min_current?: number;
  max_current?: number;
  min_power?: number;
  max_power?: number;
  /** Seconds. */
  min_duration?: number;
  max_duration?: number;
  day_of_week?: DayOfWeek[];
  reservation?: (typeof RESERVATION_TYPES)[number];
};

export type TariffElement = {
  price_components: PriceComponent[];
  restrictions?: TariffRestrictions;
};

export type Tariff = {
  country_code: string;
  party_id: string;
  id: string;
  currency: string;
  type?: TariffType;
  tariff_alt_text?: DisplayText[];
  tariff_alt_url?: string;
  min_price?: Price;
  max_price?: Price;
  elements: TariffElement[];
  start_date_time?: string;
  end_date_time?: string;
  last_updated: string;
};

const ID = /^[\x20-\x7e]+$/;
const HH_MM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

function amount(ctx: Ctx, v: unknown, path: string): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e9)
    return v;
  ctx.errors.push(`${path} must be a number of at least 0`);
  return undefined;
}

function price(ctx: Ctx, v: unknown, path: string): Price | undefined {
  const o = object(ctx, v, path);
  if (!o) return undefined;
  const excl_vat = amount(ctx, o.excl_vat, `${path}.excl_vat`);
  const incl_vat = optional(o.incl_vat, (x) =>
    amount(ctx, x, `${path}.incl_vat`),
  );
  if (excl_vat === undefined) return undefined;
  return incl_vat === undefined ? { excl_vat } : { excl_vat, incl_vat };
}

function priceComponent(
  ctx: Ctx,
  v: unknown,
  path: string,
): PriceComponent | undefined {
  const o = object(ctx, v, path);
  if (!o) return undefined;
  const before = ctx.errors.length;
  const value: PriceComponent = {
    type: oneOf(ctx, o.type, `${path}.type`, DIMENSION_TYPES)!,
    price: amount(ctx, o.price, `${path}.price`)!,
    step_size: int(ctx, o.step_size, `${path}.step_size`, 0, 100_000_000)!,
  };
  const vat = optional(o.vat, (x) => amount(ctx, x, `${path}.vat`));
  if (vat !== undefined) value.vat = vat;
  return ctx.errors.length > before ? undefined : value;
}

function restrictions(
  ctx: Ctx,
  v: unknown,
  path: string,
): TariffRestrictions | undefined {
  const o = object(ctx, v, path);
  if (!o) return undefined;
  const before = ctx.errors.length;
  const value: TariffRestrictions = {};
  const set = <K extends keyof TariffRestrictions>(
    key: K,
    check: (x: unknown, p: string) => TariffRestrictions[K] | undefined,
  ) => {
    const r = optional(o[key], (x) => check(x, `${path}.${key}`));
    if (r !== undefined) value[key] = r;
  };
  set("start_time", (x, p) => str(ctx, x, p, 5, HH_MM));
  set("end_time", (x, p) => str(ctx, x, p, 5, HH_MM));
  set("start_date", (x, p) => str(ctx, x, p, 10, DATE));
  set("end_date", (x, p) => str(ctx, x, p, 10, DATE));
  for (const key of [
    "min_kwh",
    "max_kwh",
    "min_current",
    "max_current",
    "min_power",
    "max_power",
  ] as const)
    set(key, (x, p) => amount(ctx, x, p));
  set("min_duration", (x, p) => int(ctx, x, p, 0, 100_000_000));
  set("max_duration", (x, p) => int(ctx, x, p, 0, 100_000_000));
  set("day_of_week", (x, p) =>
    array(ctx, x, p, (d, q) => oneOf(ctx, d, q, DAYS_OF_WEEK), { max: 7 }),
  );
  set("reservation", (x, p) => oneOf(ctx, x, p, RESERVATION_TYPES));
  return ctx.errors.length > before ? undefined : value;
}

function tariffElement(
  ctx: Ctx,
  v: unknown,
  path: string,
): TariffElement | undefined {
  const o = object(ctx, v, path);
  if (!o) return undefined;
  const price_components = array(
    ctx,
    o.price_components,
    `${path}.price_components`,
    (x, p) => priceComponent(ctx, x, p),
    { min: 1, max: 20 },
  );
  const r = optional(o.restrictions, (x) =>
    restrictions(ctx, x, `${path}.restrictions`),
  );
  if (!price_components) return undefined;
  return r && Object.keys(r).length
    ? { price_components, restrictions: r }
    : { price_components };
}

export function parseTariff(v: unknown): Parsed<Tariff> {
  const ctx: Ctx = { errors: [] };
  const o = object(ctx, v, "tariff");
  if (!o) return { ok: false, errors: ctx.errors };
  const value = {
    country_code: str(ctx, o.country_code, "tariff.country_code", 2, COUNTRY),
    party_id: str(ctx, o.party_id, "tariff.party_id", 3, PARTY),
    id: str(ctx, o.id, "tariff.id", 36, ID),
    currency: str(ctx, o.currency, "tariff.currency", 3, /^[A-Z]{3}$/),
    elements: array(
      ctx,
      o.elements,
      "tariff.elements",
      (x, p) => tariffElement(ctx, x, p),
      { min: 1, max: 100 },
    ),
    last_updated: dateTime(ctx, o.last_updated, "tariff.last_updated"),
  } as Tariff;
  const opt = <K extends keyof Tariff>(
    key: K,
    check: (x: unknown, p: string) => Tariff[K] | undefined,
  ) => {
    const r = optional(o[key], (x) => check(x, `tariff.${key}`));
    if (r !== undefined) value[key] = r;
  };
  opt("type", (x, p) => oneOf(ctx, x, p, TARIFF_TYPES));
  opt("tariff_alt_text", (x, p) => displayTexts(ctx, x, p));
  opt("tariff_alt_url", (x, p) => url(ctx, x, p, { httpsOnly: false }));
  opt("min_price", (x, p) => price(ctx, x, p));
  opt("max_price", (x, p) => price(ctx, x, p));
  opt("start_date_time", (x, p) => dateTime(ctx, x, p));
  opt("end_date_time", (x, p) => dateTime(ctx, x, p));
  if (ctx.errors.length === 0) {
    value.country_code = value.country_code.toUpperCase();
    value.party_id = value.party_id.toUpperCase();
  }
  return done(ctx, ctx.errors.length ? undefined : value);
}
