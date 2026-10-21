import {
  array,
  businessDetails,
  COUNTRY,
  done,
  image,
  isObject,
  object,
  optional,
  PARTY,
  str,
  url,
  type Ctx,
  type Parsed,
} from "./schema";
import type { BusinessDetails, Image } from "./types";

/**
 * OCPI 2.2.1 Locations module objects (section 8): Location, EVSE and Connector, and
 * their validators. Like schema.ts, a validator returns the object with only the fields
 * this eMSP keeps (others are dropped), or a list of problems that name fields, never
 * values.
 *
 * Kept: everything the search API and the driver app use. Dropped: related_locations,
 * energy_mix and status_schedule.
 */

export const EVSE_STATUSES = [
  "AVAILABLE",
  "BLOCKED",
  "CHARGING",
  "INOPERATIVE",
  "OUTOFORDER",
  "PLANNED",
  "REMOVED",
  "RESERVED",
  "UNKNOWN",
] as const;
export type EvseStatus = (typeof EVSE_STATUSES)[number];

export const CONNECTOR_TYPES = [
  "CHADEMO",
  "CHAOJI",
  "DOMESTIC_A",
  "DOMESTIC_B",
  "DOMESTIC_C",
  "DOMESTIC_D",
  "DOMESTIC_E",
  "DOMESTIC_F",
  "DOMESTIC_G",
  "DOMESTIC_H",
  "DOMESTIC_I",
  "DOMESTIC_J",
  "DOMESTIC_K",
  "DOMESTIC_L",
  "DOMESTIC_M",
  "DOMESTIC_N",
  "DOMESTIC_O",
  "GBT_AC",
  "GBT_DC",
  "IEC_60309_2_single_16",
  "IEC_60309_2_three_16",
  "IEC_60309_2_three_32",
  "IEC_60309_2_three_64",
  "IEC_62196_T1",
  "IEC_62196_T1_COMBO",
  "IEC_62196_T2",
  "IEC_62196_T2_COMBO",
  "IEC_62196_T3A",
  "IEC_62196_T3C",
  "NEMA_5_20",
  "NEMA_6_30",
  "NEMA_6_50",
  "NEMA_10_30",
  "NEMA_10_50",
  "NEMA_14_30",
  "NEMA_14_50",
  "PANTOGRAPH_BOTTOM_UP",
  "PANTOGRAPH_TOP_DOWN",
  "TESLA_R",
  "TESLA_S",
] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export const CONNECTOR_FORMATS = ["SOCKET", "CABLE"] as const;
export const POWER_TYPES = [
  "AC_1_PHASE",
  "AC_2_PHASE",
  "AC_2_PHASE_SPLIT",
  "AC_3_PHASE",
  "DC",
] as const;
export type PowerType = (typeof POWER_TYPES)[number];

export const CAPABILITIES = [
  "CHARGING_PROFILE_CAPABLE",
  "CHARGING_PREFERENCES_CAPABLE",
  "CHIP_CARD_SUPPORT",
  "CONTACTLESS_CARD_SUPPORT",
  "CREDIT_CARD_PAYABLE",
  "DEBIT_CARD_PAYABLE",
  "PED_TERMINAL",
  "REMOTE_START_STOP_CAPABLE",
  "RESERVABLE",
  "RFID_READER",
  "START_SESSION_CONNECTOR_ID_REQUIRED",
  "TOKEN_GROUP_CAPABLE",
  "UNLOCK_CAPABLE",
] as const;

export const PARKING_RESTRICTIONS = [
  "EV_ONLY",
  "PLUGGED",
  "DISABLED",
  "CUSTOMERS",
  "MOTORCYCLES",
] as const;
export type ParkingRestriction = (typeof PARKING_RESTRICTIONS)[number];

export const PARKING_TYPES = [
  "ALONG_MOTORWAY",
  "PARKING_GARAGE",
  "PARKING_LOT",
  "ON_DRIVEWAY",
  "ON_STREET",
  "UNDERGROUND_GARAGE",
] as const;

export const FACILITIES = [
  "HOTEL",
  "RESTAURANT",
  "CAFE",
  "MALL",
  "SUPERMARKET",
  "SPORT",
  "RECREATION_AREA",
  "NATURE",
  "MUSEUM",
  "BIKE_SHARING",
  "BUS_STOP",
  "TAXI_STAND",
  "TRAM_STOP",
  "METRO_STATION",
  "TRAIN_STATION",
  "AIRPORT",
  "PARKING_LOT",
  "CARPOOL_PARKING",
  "FUEL_STATION",
  "WIFI",
] as const;
export type Facility = (typeof FACILITIES)[number];

const TOKEN_TYPES = ["AD_HOC_USER", "APP_USER", "OTHER", "RFID"] as const;

export type DisplayText = { language: string; text: string };
export type GeoLocation = { latitude: string; longitude: string };

export type Connector = {
  id: string;
  standard: ConnectorType;
  format: (typeof CONNECTOR_FORMATS)[number];
  power_type: PowerType;
  max_voltage: number;
  max_amperage: number;
  max_electric_power?: number;
  tariff_ids?: string[];
  terms_and_conditions?: string;
  last_updated: string;
};

export type Evse = {
  uid: string;
  evse_id?: string;
  status: EvseStatus;
  capabilities?: (typeof CAPABILITIES)[number][];
  connectors: Connector[];
  floor_level?: string;
  coordinates?: GeoLocation;
  physical_reference?: string;
  directions?: DisplayText[];
  parking_restrictions?: ParkingRestriction[];
  images?: Image[];
  last_updated: string;
};

export type RegularHours = {
  weekday: number;
  period_begin: string;
  period_end: string;
};
export type ExceptionalPeriod = { period_begin: string; period_end: string };
export type Hours = {
  twentyfourseven: boolean;
  regular_hours?: RegularHours[];
  exceptional_openings?: ExceptionalPeriod[];
  exceptional_closings?: ExceptionalPeriod[];
};

export type PublishTokenType = {
  uid?: string;
  type?: (typeof TOKEN_TYPES)[number];
  visual_number?: string;
  issuer?: string;
  group_id?: string;
};

export type Location = {
  country_code: string;
  party_id: string;
  id: string;
  publish: boolean;
  publish_allowed_to?: PublishTokenType[];
  name?: string;
  address: string;
  city: string;
  postal_code?: string;
  state?: string;
  country: string;
  coordinates: GeoLocation;
  parking_type?: (typeof PARKING_TYPES)[number];
  evses?: Evse[];
  directions?: DisplayText[];
  operator?: BusinessDetails;
  suboperator?: BusinessDetails;
  owner?: BusinessDetails;
  facilities?: Facility[];
  time_zone: string;
  opening_times?: Hours;
  charging_when_closed?: boolean;
  images?: Image[];
  last_updated: string;
};

/** CiString(36) and the like: printable ASCII. */
const ID = /^[\x20-\x7e]+$/;
const LATITUDE = /^-?[0-9]{1,2}\.[0-9]{5,7}$/;
const LONGITUDE = /^-?[0-9]{1,3}\.[0-9]{5,7}$/;
const HH_MM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
/** OCPI DateTime: RFC 3339, UTC or with an offset, optional fraction. */
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/;

export function dateTime(
  ctx: Ctx,
  v: unknown,
  path: string,
): string | undefined {
  if (
    typeof v !== "string" ||
    !DATE_TIME.test(v) ||
    Number.isNaN(dateTimeMs(v))
  ) {
    ctx.errors.push(`${path} must be a DateTime`);
    return undefined;
  }
  return v;
}

/** Milliseconds since the epoch of an OCPI DateTime. OCPI says UTC: no zone reads as UTC. */
export function dateTimeMs(v: string): number {
  return Date.parse(/(Z|[+-]\d{2}:\d{2})$/.test(v) ? v : `${v}Z`);
}

export function oneOf<T extends string>(
  ctx: Ctx,
  v: unknown,
  path: string,
  values: readonly T[],
): T | undefined {
  if (typeof v === "string" && (values as readonly string[]).includes(v))
    return v as T;
  ctx.errors.push(`${path} must be one of the OCPI 2.2.1 values`);
  return undefined;
}

export function bool(ctx: Ctx, v: unknown, path: string): boolean | undefined {
  if (typeof v === "boolean") return v;
  ctx.errors.push(`${path} must be a boolean`);
  return undefined;
}

export function int(
  ctx: Ctx,
  v: unknown,
  path: string,
  min: number,
  max: number,
): number | undefined {
  if (Number.isInteger(v) && (v as number) >= min && (v as number) <= max)
    return v as number;
  ctx.errors.push(`${path} must be a whole number from ${min} to ${max}`);
  return undefined;
}

/** Sets `out[key]` when the optional field is present (and valid). */
function maybe<T extends object, K extends keyof T>(
  out: T,
  key: K,
  v: unknown,
  check: (v: unknown) => T[K] | undefined,
) {
  const r = optional(v, check);
  if (r !== undefined) out[key] = r;
}

export function displayTexts(
  ctx: Ctx,
  v: unknown,
  path: string,
): DisplayText[] | undefined {
  return array(
    ctx,
    v,
    path,
    (x, p) => {
      const o = object(ctx, x, p);
      if (!o) return undefined;
      const language = str(ctx, o.language, `${p}.language`, 2);
      const text = str(ctx, o.text, `${p}.text`, 512);
      return language && text ? { language, text } : undefined;
    },
    { max: 20 },
  );
}

export function geoLocation(
  ctx: Ctx,
  v: unknown,
  path: string,
): GeoLocation | undefined {
  const o = object(ctx, v, path);
  if (!o) return undefined;
  const latitude = str(ctx, o.latitude, `${path}.latitude`, 10, LATITUDE);
  const longitude = str(ctx, o.longitude, `${path}.longitude`, 11, LONGITUDE);
  if (!latitude || !longitude) return undefined;
  if (Math.abs(Number(latitude)) > 90 || Math.abs(Number(longitude)) > 180) {
    ctx.errors.push(`${path} is out of range`);
    return undefined;
  }
  return { latitude, longitude };
}

const enumList = <T extends string>(
  ctx: Ctx,
  v: unknown,
  path: string,
  values: readonly T[],
) =>
  array(ctx, v, path, (x, p) => oneOf(ctx, x, p, values), {
    max: values.length,
  });

function periods(
  ctx: Ctx,
  v: unknown,
  path: string,
): ExceptionalPeriod[] | undefined {
  return array(
    ctx,
    v,
    path,
    (x, p) => {
      const o = object(ctx, x, p);
      if (!o) return undefined;
      const period_begin = dateTime(ctx, o.period_begin, `${p}.period_begin`);
      const period_end = dateTime(ctx, o.period_end, `${p}.period_end`);
      return period_begin && period_end
        ? { period_begin, period_end }
        : undefined;
    },
    { max: 500 },
  );
}

function hours(ctx: Ctx, v: unknown, path: string): Hours | undefined {
  const o = object(ctx, v, path);
  if (!o) return undefined;
  const twentyfourseven = bool(
    ctx,
    o.twentyfourseven,
    `${path}.twentyfourseven`,
  );
  if (twentyfourseven === undefined) return undefined;
  const value: Hours = { twentyfourseven };
  maybe(value, "regular_hours", o.regular_hours, (x) =>
    array(
      ctx,
      x,
      `${path}.regular_hours`,
      (r, p) => {
        const h = object(ctx, r, p);
        if (!h) return undefined;
        const weekday = int(ctx, h.weekday, `${p}.weekday`, 1, 7);
        const period_begin = str(
          ctx,
          h.period_begin,
          `${p}.period_begin`,
          5,
          HH_MM,
        );
        const period_end = str(ctx, h.period_end, `${p}.period_end`, 5, HH_MM);
        return weekday && period_begin && period_end
          ? { weekday, period_begin, period_end }
          : undefined;
      },
      { max: 50 },
    ),
  );
  maybe(value, "exceptional_openings", o.exceptional_openings, (x) =>
    periods(ctx, x, `${path}.exceptional_openings`),
  );
  maybe(value, "exceptional_closings", o.exceptional_closings, (x) =>
    periods(ctx, x, `${path}.exceptional_closings`),
  );
  return value;
}

function publishTokens(
  ctx: Ctx,
  v: unknown,
  path: string,
): PublishTokenType[] | undefined {
  return array(
    ctx,
    v,
    path,
    (x, p) => {
      const o = object(ctx, x, p);
      if (!o) return undefined;
      const value: PublishTokenType = {};
      maybe(value, "uid", o.uid, (y) => str(ctx, y, `${p}.uid`, 36));
      maybe(value, "type", o.type, (y) =>
        oneOf(ctx, y, `${p}.type`, TOKEN_TYPES),
      );
      maybe(value, "visual_number", o.visual_number, (y) =>
        str(ctx, y, `${p}.visual_number`, 64),
      );
      maybe(value, "issuer", o.issuer, (y) => str(ctx, y, `${p}.issuer`, 64));
      maybe(value, "group_id", o.group_id, (y) =>
        str(ctx, y, `${p}.group_id`, 36),
      );
      return value;
    },
    { max: 100 },
  );
}

function connector(ctx: Ctx, v: unknown, path: string): Connector | undefined {
  const o = object(ctx, v, path);
  if (!o) return undefined;
  const before = ctx.errors.length;
  const value = {
    id: str(ctx, o.id, `${path}.id`, 36, ID),
    standard: oneOf(ctx, o.standard, `${path}.standard`, CONNECTOR_TYPES),
    format: oneOf(ctx, o.format, `${path}.format`, CONNECTOR_FORMATS),
    power_type: oneOf(ctx, o.power_type, `${path}.power_type`, POWER_TYPES),
    max_voltage: int(ctx, o.max_voltage, `${path}.max_voltage`, 0, 100_000),
    max_amperage: int(ctx, o.max_amperage, `${path}.max_amperage`, 0, 100_000),
    last_updated: dateTime(ctx, o.last_updated, `${path}.last_updated`),
  } as Connector;
  maybe(value, "max_electric_power", o.max_electric_power, (x) =>
    int(ctx, x, `${path}.max_electric_power`, 0, 10_000_000),
  );
  maybe(value, "tariff_ids", o.tariff_ids, (x) =>
    array(ctx, x, `${path}.tariff_ids`, (t, p) => str(ctx, t, p, 36, ID), {
      max: 50,
    }),
  );
  maybe(value, "terms_and_conditions", o.terms_and_conditions, (x) =>
    url(ctx, x, `${path}.terms_and_conditions`, { httpsOnly: false }),
  );
  return ctx.errors.length > before ? undefined : value;
}

function evse(ctx: Ctx, v: unknown, path: string): Evse | undefined {
  const o = object(ctx, v, path);
  if (!o) return undefined;
  const before = ctx.errors.length;
  const value = {
    uid: str(ctx, o.uid, `${path}.uid`, 36, ID),
    status: oneOf(ctx, o.status, `${path}.status`, EVSE_STATUSES),
    connectors: array(
      ctx,
      o.connectors,
      `${path}.connectors`,
      (x, p) => connector(ctx, x, p),
      { min: 1, max: 50 },
    ),
    last_updated: dateTime(ctx, o.last_updated, `${path}.last_updated`),
  } as Evse;
  maybe(value, "evse_id", o.evse_id, (x) =>
    str(ctx, x, `${path}.evse_id`, 48, ID),
  );
  maybe(value, "capabilities", o.capabilities, (x) =>
    enumList(ctx, x, `${path}.capabilities`, CAPABILITIES),
  );
  maybe(value, "floor_level", o.floor_level, (x) =>
    str(ctx, x, `${path}.floor_level`, 4),
  );
  maybe(value, "coordinates", o.coordinates, (x) =>
    geoLocation(ctx, x, `${path}.coordinates`),
  );
  maybe(value, "physical_reference", o.physical_reference, (x) =>
    str(ctx, x, `${path}.physical_reference`, 16),
  );
  maybe(value, "directions", o.directions, (x) =>
    displayTexts(ctx, x, `${path}.directions`),
  );
  maybe(value, "parking_restrictions", o.parking_restrictions, (x) =>
    enumList(ctx, x, `${path}.parking_restrictions`, PARKING_RESTRICTIONS),
  );
  maybe(value, "images", o.images, (x) =>
    array(ctx, x, `${path}.images`, (i, p) => image(ctx, i, p), { max: 20 }),
  );
  if (ctx.errors.length > before) return undefined;
  const ids = new Set(value.connectors.map((c) => c.id.toUpperCase()));
  if (ids.size !== value.connectors.length) {
    ctx.errors.push(`${path}.connectors has duplicate ids`);
    return undefined;
  }
  return value;
}

function location(ctx: Ctx, v: unknown, path: string): Location | undefined {
  const o = object(ctx, v, path);
  if (!o) return undefined;
  const before = ctx.errors.length;
  const value = {
    country_code: str(ctx, o.country_code, `${path}.country_code`, 2, COUNTRY),
    party_id: str(ctx, o.party_id, `${path}.party_id`, 3, PARTY),
    id: str(ctx, o.id, `${path}.id`, 36, ID),
    publish: bool(ctx, o.publish, `${path}.publish`),
    address: str(ctx, o.address, `${path}.address`, 45),
    city: str(ctx, o.city, `${path}.city`, 45),
    country: str(ctx, o.country, `${path}.country`, 3, /^[A-Z]{3}$/),
    coordinates: geoLocation(ctx, o.coordinates, `${path}.coordinates`),
    time_zone: str(ctx, o.time_zone, `${path}.time_zone`, 255),
    last_updated: dateTime(ctx, o.last_updated, `${path}.last_updated`),
  } as Location;
  maybe(value, "publish_allowed_to", o.publish_allowed_to, (x) =>
    publishTokens(ctx, x, `${path}.publish_allowed_to`),
  );
  maybe(value, "name", o.name, (x) => str(ctx, x, `${path}.name`, 255));
  maybe(value, "postal_code", o.postal_code, (x) =>
    str(ctx, x, `${path}.postal_code`, 10),
  );
  maybe(value, "state", o.state, (x) => str(ctx, x, `${path}.state`, 20));
  maybe(value, "parking_type", o.parking_type, (x) =>
    oneOf(ctx, x, `${path}.parking_type`, PARKING_TYPES),
  );
  maybe(value, "evses", o.evses, (x) =>
    array(ctx, x, `${path}.evses`, (e, p) => evse(ctx, e, p), { max: 500 }),
  );
  maybe(value, "directions", o.directions, (x) =>
    displayTexts(ctx, x, `${path}.directions`),
  );
  for (const key of ["operator", "suboperator", "owner"] as const)
    maybe(value, key, o[key], (x) => businessDetails(ctx, x, `${path}.${key}`));
  maybe(value, "facilities", o.facilities, (x) =>
    enumList(ctx, x, `${path}.facilities`, FACILITIES),
  );
  maybe(value, "opening_times", o.opening_times, (x) =>
    hours(ctx, x, `${path}.opening_times`),
  );
  maybe(value, "charging_when_closed", o.charging_when_closed, (x) =>
    bool(ctx, x, `${path}.charging_when_closed`),
  );
  maybe(value, "images", o.images, (x) =>
    array(ctx, x, `${path}.images`, (i, p) => image(ctx, i, p), { max: 20 }),
  );
  if (ctx.errors.length > before) return undefined;
  // CiString: compare and store upper case.
  value.country_code = value.country_code.toUpperCase();
  value.party_id = value.party_id.toUpperCase();
  const uids = new Set((value.evses ?? []).map((e) => e.uid.toUpperCase()));
  if (uids.size !== (value.evses ?? []).length) {
    ctx.errors.push(`${path}.evses has duplicate uids`);
    return undefined;
  }
  return value;
}

export function parseLocation(v: unknown): Parsed<Location> {
  const ctx: Ctx = { errors: [] };
  return done(ctx, location(ctx, v, "location"));
}

export function parseEvse(v: unknown): Parsed<Evse> {
  const ctx: Ctx = { errors: [] };
  return done(ctx, evse(ctx, v, "evse"));
}

export function parseConnector(v: unknown): Parsed<Connector> {
  const ctx: Ctx = { errors: [] };
  return done(ctx, connector(ctx, v, "connector"));
}

/**
 * The body of a PATCH: an object with a valid last_updated. The fields it carries are
 * merged into the stored object, and the result is validated as a whole.
 */
export function parsePatch(v: unknown): Parsed<Record<string, unknown>> {
  const ctx: Ctx = { errors: [] };
  if (!isObject(v)) return { ok: false, errors: ["patch must be an object"] };
  dateTime(ctx, v.last_updated, "patch.last_updated");
  return done(ctx, v);
}

/** Case-insensitive comparison of CiString values. */
export const sameId = (a: string, b: string) =>
  a.toUpperCase() === b.toUpperCase();

/** A connector's maximum power in W: max_electric_power, or volts × amps × phases. */
export function connectorPowerW(c: Connector): number {
  if (c.max_electric_power) return c.max_electric_power;
  const phases =
    c.power_type === "AC_3_PHASE"
      ? 3
      : c.power_type === "AC_2_PHASE" || c.power_type === "AC_2_PHASE_SPLIT"
        ? 2
        : 1;
  return c.max_voltage * c.max_amperage * phases;
}
