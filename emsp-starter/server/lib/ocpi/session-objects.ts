import {
  bool,
  CONNECTOR_FORMATS,
  CONNECTOR_TYPES,
  dateTime,
  geoLocation,
  int,
  oneOf,
  POWER_TYPES,
  type ConnectorType,
  type GeoLocation,
  type PowerType,
} from "./locations";
import {
  array,
  COUNTRY,
  done,
  object,
  optional,
  PARTY,
  str,
  type Ctx,
  type Parsed,
} from "./schema";
import { parseTariff, type Tariff } from "./tariffs";
import { TOKEN_TYPES, type TokenType } from "./token-objects";

/**
 * OCPI 2.2.1 Sessions and CDRs module objects (sections 9 and 10): the Session a CPO
 * sends while a driver charges, and the CDR (charge detail record) it sends once the
 * session is over. Like schema.ts, a validator returns the object with only the fields
 * the spec defines, or a list of problems that name fields, never values.
 */

export const SESSION_STATUSES = [
  "ACTIVE",
  "COMPLETED",
  "INVALID",
  "PENDING",
  "RESERVATION",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const AUTH_METHODS = ["AUTH_REQUEST", "COMMAND", "WHITELIST"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const CDR_DIMENSION_TYPES = [
  "CURRENT",
  "ENERGY",
  "ENERGY_EXPORT",
  "ENERGY_IMPORT",
  "MAX_CURRENT",
  "MIN_CURRENT",
  "MAX_POWER",
  "MIN_POWER",
  "PARKING_TIME",
  "POWER",
  "RESERVATION_TIME",
  "STATE_OF_CHARGE",
  "TIME",
] as const;
export type CdrDimensionType = (typeof CDR_DIMENSION_TYPES)[number];

/** The token a session or CDR was charged with (section 10.4.3). */
export type CdrToken = {
  /** The token's issuer: for our drivers, our country code and party ID. */
  country_code: string;
  party_id: string;
  uid: string;
  type: TokenType;
  contract_id: string;
};

export type CdrDimension = { type: CdrDimensionType; volume: number };

export type ChargingPeriod = {
  start_date_time: string;
  dimensions: CdrDimension[];
  tariff_id?: string;
};

/**
 * An amount. Unlike a tariff's prices, a CDR's may be negative: some CPOs send a
 * credit CDR's amounts that way.
 */
export type Amount = { excl_vat: number; incl_vat?: number };

export type Session = {
  country_code: string;
  party_id: string;
  id: string;
  start_date_time: string;
  end_date_time?: string;
  kwh: number;
  cdr_token: CdrToken;
  auth_method: AuthMethod;
  authorization_reference?: string;
  location_id: string;
  evse_uid: string;
  connector_id: string;
  meter_id?: string;
  currency: string;
  charging_periods?: ChargingPeriod[];
  total_cost?: Amount;
  status: SessionStatus;
  last_updated: string;
};

export type CdrLocation = {
  id: string;
  name?: string;
  address: string;
  city: string;
  postal_code?: string;
  state?: string;
  country: string;
  coordinates: GeoLocation;
  evse_uid: string;
  evse_id: string;
  connector_id: string;
  connector_standard: ConnectorType;
  connector_format: (typeof CONNECTOR_FORMATS)[number];
  connector_power_type: PowerType;
};

export type SignedValue = {
  nature: string;
  plain_data: string;
  signed_data: string;
};

export type SignedData = {
  encoding_method: string;
  encoding_method_version?: number;
  public_key?: string;
  signed_values: SignedValue[];
  url?: string;
};

export type Cdr = {
  country_code: string;
  party_id: string;
  id: string;
  start_date_time: string;
  end_date_time: string;
  session_id?: string;
  cdr_token: CdrToken;
  auth_method: AuthMethod;
  authorization_reference?: string;
  cdr_location: CdrLocation;
  meter_id?: string;
  currency: string;
  tariffs?: Tariff[];
  charging_periods: ChargingPeriod[];
  signed_data?: SignedData;
  total_cost: Amount;
  total_fixed_cost?: Amount;
  /** kWh. */
  total_energy: number;
  total_energy_cost?: Amount;
  /** Hours. */
  total_time: number;
  total_time_cost?: Amount;
  /** Hours. */
  total_parking_time?: number;
  total_parking_cost?: Amount;
  total_reservation_cost?: Amount;
  remark?: string;
  invoice_reference_id?: string;
  /** A credit CDR: it reverses the CDR named by credit_reference_id. */
  credit?: boolean;
  credit_reference_id?: string;
  home_charging_compensation?: boolean;
  last_updated: string;
};

/** CiString and the like: printable ASCII. */
const ID = /^[\x20-\x7e]+$/;
const CURRENCY = /^[A-Z]{3}$/;
/** Longest list of charging periods we take: a day of one-minute periods, with room. */
const MAX_PERIODS = 5000;

function number(
  ctx: Ctx,
  v: unknown,
  path: string,
  { min = -1e12 }: { min?: number } = {},
): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v >= min && v < 1e12)
    return v;
  ctx.errors.push(
    min === 0
      ? `${path} must be a number of at least 0`
      : `${path} must be a number`,
  );
  return undefined;
}

function amount(ctx: Ctx, v: unknown, path: string): Amount | undefined {
  const o = object(ctx, v, path);
  if (!o) return undefined;
  const excl_vat = number(ctx, o.excl_vat, `${path}.excl_vat`);
  const incl_vat = optional(o.incl_vat, (x) =>
    number(ctx, x, `${path}.incl_vat`),
  );
  if (excl_vat === undefined) return undefined;
  return incl_vat === undefined ? { excl_vat } : { excl_vat, incl_vat };
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

function cdrToken(ctx: Ctx, v: unknown, path: string): CdrToken | undefined {
  const o = object(ctx, v, path);
  if (!o) return undefined;
  const before = ctx.errors.length;
  const value = {
    country_code: str(ctx, o.country_code, `${path}.country_code`, 2, COUNTRY),
    party_id: str(ctx, o.party_id, `${path}.party_id`, 3, PARTY),
    uid: str(ctx, o.uid, `${path}.uid`, 36, ID),
    type: oneOf(ctx, o.type, `${path}.type`, TOKEN_TYPES),
    contract_id: str(ctx, o.contract_id, `${path}.contract_id`, 36, ID),
  } as CdrToken;
  if (ctx.errors.length > before) return undefined;
  value.country_code = value.country_code.toUpperCase();
  value.party_id = value.party_id.toUpperCase();
  return value;
}

function chargingPeriods(
  ctx: Ctx,
  v: unknown,
  path: string,
  min: number,
): ChargingPeriod[] | undefined {
  return array(
    ctx,
    v,
    path,
    (x, p) => {
      const o = object(ctx, x, p);
      if (!o) return undefined;
      const before = ctx.errors.length;
      const value = {
        start_date_time: dateTime(
          ctx,
          o.start_date_time,
          `${p}.start_date_time`,
        ),
        dimensions: array(
          ctx,
          o.dimensions,
          `${p}.dimensions`,
          (d, q) => {
            const dim = object(ctx, d, q);
            if (!dim) return undefined;
            const type = oneOf(ctx, dim.type, `${q}.type`, CDR_DIMENSION_TYPES);
            const volume = number(ctx, dim.volume, `${q}.volume`);
            return type && volume !== undefined ? { type, volume } : undefined;
          },
          { min: 1, max: 50 },
        ),
      } as ChargingPeriod;
      maybe(value, "tariff_id", o.tariff_id, (y) =>
        str(ctx, y, `${p}.tariff_id`, 36, ID),
      );
      return ctx.errors.length > before ? undefined : value;
    },
    { min, max: MAX_PERIODS },
  );
}

function cdrLocation(
  ctx: Ctx,
  v: unknown,
  path: string,
): CdrLocation | undefined {
  const o = object(ctx, v, path);
  if (!o) return undefined;
  const before = ctx.errors.length;
  const value = {
    id: str(ctx, o.id, `${path}.id`, 36, ID),
    address: str(ctx, o.address, `${path}.address`, 45),
    city: str(ctx, o.city, `${path}.city`, 45),
    country: str(ctx, o.country, `${path}.country`, 3, /^[A-Z]{3}$/),
    coordinates: geoLocation(ctx, o.coordinates, `${path}.coordinates`),
    evse_uid: str(ctx, o.evse_uid, `${path}.evse_uid`, 36, ID),
    evse_id: str(ctx, o.evse_id, `${path}.evse_id`, 48, ID),
    connector_id: str(ctx, o.connector_id, `${path}.connector_id`, 36, ID),
    connector_standard: oneOf(
      ctx,
      o.connector_standard,
      `${path}.connector_standard`,
      CONNECTOR_TYPES,
    ),
    connector_format: oneOf(
      ctx,
      o.connector_format,
      `${path}.connector_format`,
      CONNECTOR_FORMATS,
    ),
    connector_power_type: oneOf(
      ctx,
      o.connector_power_type,
      `${path}.connector_power_type`,
      POWER_TYPES,
    ),
  } as CdrLocation;
  maybe(value, "name", o.name, (x) => str(ctx, x, `${path}.name`, 255));
  maybe(value, "postal_code", o.postal_code, (x) =>
    str(ctx, x, `${path}.postal_code`, 10),
  );
  maybe(value, "state", o.state, (x) => str(ctx, x, `${path}.state`, 20));
  return ctx.errors.length > before ? undefined : value;
}

function signedData(
  ctx: Ctx,
  v: unknown,
  path: string,
): SignedData | undefined {
  const o = object(ctx, v, path);
  if (!o) return undefined;
  const before = ctx.errors.length;
  const value = {
    encoding_method: str(
      ctx,
      o.encoding_method,
      `${path}.encoding_method`,
      36,
      ID,
    ),
    signed_values: array(
      ctx,
      o.signed_values,
      `${path}.signed_values`,
      (x, p) => {
        const s = object(ctx, x, p);
        if (!s) return undefined;
        const nature = str(ctx, s.nature, `${p}.nature`, 32, ID);
        const plain_data = str(ctx, s.plain_data, `${p}.plain_data`, 512);
        const signed = str(ctx, s.signed_data, `${p}.signed_data`, 5000);
        return nature && plain_data && signed
          ? { nature, plain_data, signed_data: signed }
          : undefined;
      },
      { min: 1, max: 100 },
    ),
  } as SignedData;
  maybe(value, "encoding_method_version", o.encoding_method_version, (x) =>
    int(ctx, x, `${path}.encoding_method_version`, 0, 1_000_000),
  );
  maybe(value, "public_key", o.public_key, (x) =>
    str(ctx, x, `${path}.public_key`, 512),
  );
  maybe(value, "url", o.url, (x) => str(ctx, x, `${path}.url`, 512));
  return ctx.errors.length > before ? undefined : value;
}

function session(ctx: Ctx, v: unknown, path: string): Session | undefined {
  const o = object(ctx, v, path);
  if (!o) return undefined;
  const before = ctx.errors.length;
  const value = {
    country_code: str(ctx, o.country_code, `${path}.country_code`, 2, COUNTRY),
    party_id: str(ctx, o.party_id, `${path}.party_id`, 3, PARTY),
    id: str(ctx, o.id, `${path}.id`, 36, ID),
    start_date_time: dateTime(
      ctx,
      o.start_date_time,
      `${path}.start_date_time`,
    ),
    kwh: number(ctx, o.kwh, `${path}.kwh`, { min: 0 }),
    cdr_token: cdrToken(ctx, o.cdr_token, `${path}.cdr_token`),
    auth_method: oneOf(ctx, o.auth_method, `${path}.auth_method`, AUTH_METHODS),
    location_id: str(ctx, o.location_id, `${path}.location_id`, 36, ID),
    evse_uid: str(ctx, o.evse_uid, `${path}.evse_uid`, 36, ID),
    connector_id: str(ctx, o.connector_id, `${path}.connector_id`, 36, ID),
    currency: str(ctx, o.currency, `${path}.currency`, 3, CURRENCY),
    status: oneOf(ctx, o.status, `${path}.status`, SESSION_STATUSES),
    last_updated: dateTime(ctx, o.last_updated, `${path}.last_updated`),
  } as Session;
  maybe(value, "end_date_time", o.end_date_time, (x) =>
    dateTime(ctx, x, `${path}.end_date_time`),
  );
  maybe(value, "authorization_reference", o.authorization_reference, (x) =>
    str(ctx, x, `${path}.authorization_reference`, 36, ID),
  );
  maybe(value, "meter_id", o.meter_id, (x) =>
    str(ctx, x, `${path}.meter_id`, 255),
  );
  maybe(value, "charging_periods", o.charging_periods, (x) =>
    chargingPeriods(ctx, x, `${path}.charging_periods`, 0),
  );
  maybe(value, "total_cost", o.total_cost, (x) =>
    amount(ctx, x, `${path}.total_cost`),
  );
  if (ctx.errors.length > before) return undefined;
  // CiString: compare and store upper case.
  value.country_code = value.country_code.toUpperCase();
  value.party_id = value.party_id.toUpperCase();
  return value;
}

function cdr(ctx: Ctx, v: unknown, path: string): Cdr | undefined {
  const o = object(ctx, v, path);
  if (!o) return undefined;
  const before = ctx.errors.length;
  const value = {
    country_code: str(ctx, o.country_code, `${path}.country_code`, 2, COUNTRY),
    party_id: str(ctx, o.party_id, `${path}.party_id`, 3, PARTY),
    id: str(ctx, o.id, `${path}.id`, 39, ID),
    start_date_time: dateTime(
      ctx,
      o.start_date_time,
      `${path}.start_date_time`,
    ),
    end_date_time: dateTime(ctx, o.end_date_time, `${path}.end_date_time`),
    cdr_token: cdrToken(ctx, o.cdr_token, `${path}.cdr_token`),
    auth_method: oneOf(ctx, o.auth_method, `${path}.auth_method`, AUTH_METHODS),
    cdr_location: cdrLocation(ctx, o.cdr_location, `${path}.cdr_location`),
    currency: str(ctx, o.currency, `${path}.currency`, 3, CURRENCY),
    charging_periods: chargingPeriods(
      ctx,
      o.charging_periods,
      `${path}.charging_periods`,
      1,
    ),
    total_cost: amount(ctx, o.total_cost, `${path}.total_cost`),
    total_energy: number(ctx, o.total_energy, `${path}.total_energy`, {
      min: 0,
    }),
    total_time: number(ctx, o.total_time, `${path}.total_time`, { min: 0 }),
    last_updated: dateTime(ctx, o.last_updated, `${path}.last_updated`),
  } as Cdr;
  maybe(value, "session_id", o.session_id, (x) =>
    str(ctx, x, `${path}.session_id`, 36, ID),
  );
  maybe(value, "authorization_reference", o.authorization_reference, (x) =>
    str(ctx, x, `${path}.authorization_reference`, 36, ID),
  );
  maybe(value, "meter_id", o.meter_id, (x) =>
    str(ctx, x, `${path}.meter_id`, 255),
  );
  maybe(value, "tariffs", o.tariffs, (x) =>
    array(
      ctx,
      x,
      `${path}.tariffs`,
      (t, p) => {
        const parsed = parseTariff(t);
        if (parsed.ok) return parsed.value;
        ctx.errors.push(...parsed.errors.map((e) => `${p}: ${e}`));
        return undefined;
      },
      { max: 20 },
    ),
  );
  maybe(value, "signed_data", o.signed_data, (x) =>
    signedData(ctx, x, `${path}.signed_data`),
  );
  for (const key of [
    "total_fixed_cost",
    "total_energy_cost",
    "total_time_cost",
    "total_parking_cost",
    "total_reservation_cost",
  ] as const)
    maybe(value, key, o[key], (x) => amount(ctx, x, `${path}.${key}`));
  maybe(value, "total_parking_time", o.total_parking_time, (x) =>
    number(ctx, x, `${path}.total_parking_time`, { min: 0 }),
  );
  maybe(value, "remark", o.remark, (x) => str(ctx, x, `${path}.remark`, 255));
  maybe(value, "invoice_reference_id", o.invoice_reference_id, (x) =>
    str(ctx, x, `${path}.invoice_reference_id`, 39, ID),
  );
  maybe(value, "credit", o.credit, (x) => bool(ctx, x, `${path}.credit`));
  maybe(value, "credit_reference_id", o.credit_reference_id, (x) =>
    str(ctx, x, `${path}.credit_reference_id`, 39, ID),
  );
  maybe(
    value,
    "home_charging_compensation",
    o.home_charging_compensation,
    (x) => bool(ctx, x, `${path}.home_charging_compensation`),
  );
  if (ctx.errors.length > before) return undefined;
  if (value.credit && !value.credit_reference_id) {
    ctx.errors.push(`${path}.credit_reference_id is required for a credit CDR`);
    return undefined;
  }
  value.country_code = value.country_code.toUpperCase();
  value.party_id = value.party_id.toUpperCase();
  return value;
}

/** A whole Session, as a CPO PUTs it or its Sender serves it. */
export function parseSession(v: unknown): Parsed<Session> {
  const ctx: Ctx = { errors: [] };
  return done(ctx, session(ctx, v, "session"));
}

/** A CDR, as a CPO POSTs it or its Sender serves it. */
export function parseCdr(v: unknown): Parsed<Cdr> {
  const ctx: Ctx = { errors: [] };
  return done(ctx, cdr(ctx, v, "cdr"));
}
