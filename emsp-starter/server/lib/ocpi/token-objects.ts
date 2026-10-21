import { dateTime, displayTexts, oneOf, type DisplayText } from "./locations";
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

/**
 * OCPI 2.2.1 Tokens module objects (section 12): Token, LocationReferences and
 * AuthorizationInfo, and their validators. (The credentials tokens peers call each
 * other with are in tokens.ts.) Like schema.ts, a validator returns the object with only
 * the fields the spec defines, or a list of problems that name fields, never values.
 */

export const TOKEN_TYPES = [
  "AD_HOC_USER",
  "APP_USER",
  "OTHER",
  "RFID",
] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];

/** When a CPO may let a token charge without asking us first (section 12.4.4). */
export const WHITELIST_TYPES = [
  "ALWAYS",
  "ALLOWED",
  "ALLOWED_OFFLINE",
  "NEVER",
] as const;
export type WhitelistType = (typeof WHITELIST_TYPES)[number];

export const ALLOWED_TYPES = [
  "ALLOWED",
  "BLOCKED",
  "EXPIRED",
  "NO_CREDIT",
  "NOT_ALLOWED",
] as const;
export type AllowedType = (typeof ALLOWED_TYPES)[number];

export const PROFILE_TYPES = ["CHEAP", "FAST", "GREEN", "REGULAR"] as const;
export type ProfileType = (typeof PROFILE_TYPES)[number];

export type EnergyContract = { supplier_name: string; contract_id?: string };

export type Token = {
  country_code: string;
  party_id: string;
  uid: string;
  type: TokenType;
  contract_id: string;
  visual_number?: string;
  issuer: string;
  group_id?: string;
  valid: boolean;
  whitelist: WhitelistType;
  language?: string;
  default_profile_type?: ProfileType;
  energy_contract?: EnergyContract;
  last_updated: string;
};

export type LocationReferences = { location_id: string; evse_uids?: string[] };

export type AuthorizationInfo = {
  allowed: AllowedType;
  token: Token;
  location?: LocationReferences;
  authorization_reference?: string;
  info?: DisplayText;
};

/** CiString(36) and the like: printable ASCII. */
const ID = /^[\x20-\x7e]+$/;
const LANGUAGE = /^[a-z]{2}$/;

function token(ctx: Ctx, v: unknown, path: string): Token | undefined {
  const o = object(ctx, v, path);
  if (!o) return undefined;
  const before = ctx.errors.length;
  const value = {
    country_code: str(ctx, o.country_code, `${path}.country_code`, 2, COUNTRY),
    party_id: str(ctx, o.party_id, `${path}.party_id`, 3, PARTY),
    uid: str(ctx, o.uid, `${path}.uid`, 36, ID),
    type: oneOf(ctx, o.type, `${path}.type`, TOKEN_TYPES),
    contract_id: str(ctx, o.contract_id, `${path}.contract_id`, 36, ID),
    issuer: str(ctx, o.issuer, `${path}.issuer`, 64),
    valid: typeof o.valid === "boolean" ? o.valid : undefined,
    whitelist: oneOf(ctx, o.whitelist, `${path}.whitelist`, WHITELIST_TYPES),
    last_updated: dateTime(ctx, o.last_updated, `${path}.last_updated`),
  } as Token;
  if (typeof o.valid !== "boolean")
    ctx.errors.push(`${path}.valid must be a boolean`);
  const visual = optional(o.visual_number, (x) =>
    str(ctx, x, `${path}.visual_number`, 64),
  );
  const group = optional(o.group_id, (x) =>
    str(ctx, x, `${path}.group_id`, 36, ID),
  );
  const language = optional(o.language, (x) =>
    str(ctx, x, `${path}.language`, 2, LANGUAGE),
  );
  const profile = optional(o.default_profile_type, (x) =>
    oneOf(ctx, x, `${path}.default_profile_type`, PROFILE_TYPES),
  );
  const energy = optional(o.energy_contract, (x) => {
    const e = object(ctx, x, `${path}.energy_contract`);
    if (!e) return undefined;
    const supplier_name = str(
      ctx,
      e.supplier_name,
      `${path}.energy_contract.supplier_name`,
      64,
    );
    const contract_id = optional(e.contract_id, (y) =>
      str(ctx, y, `${path}.energy_contract.contract_id`, 64),
    );
    if (!supplier_name) return undefined;
    return contract_id ? { supplier_name, contract_id } : { supplier_name };
  });
  if (ctx.errors.length > before) return undefined;
  value.country_code = value.country_code.toUpperCase();
  value.party_id = value.party_id.toUpperCase();
  if (visual !== undefined) value.visual_number = visual;
  if (group !== undefined) value.group_id = group;
  if (language !== undefined) value.language = language;
  if (profile !== undefined) value.default_profile_type = profile;
  if (energy !== undefined) value.energy_contract = energy;
  return value;
}

export function parseToken(v: unknown): Parsed<Token> {
  const ctx: Ctx = { errors: [] };
  return done(ctx, token(ctx, v, "token"));
}

/**
 * The optional body of a real-time authorization: the location (and EVSEs) the driver
 * wants to charge at. An empty body means no location was given.
 */
export function parseLocationReferences(
  v: unknown,
): Parsed<LocationReferences> {
  const ctx: Ctx = { errors: [] };
  const o = object(ctx, v, "location_references");
  if (!o) return { ok: false, errors: ctx.errors };
  const location_id = str(
    ctx,
    o.location_id,
    "location_references.location_id",
    36,
    ID,
  );
  const evse_uids = optional(o.evse_uids, (x) =>
    array(
      ctx,
      x,
      "location_references.evse_uids",
      (y, p) => str(ctx, y, p, 36, ID),
      { max: 100 },
    ),
  );
  if (!location_id) return done<LocationReferences>(ctx, undefined);
  return done(ctx, evse_uids ? { location_id, evse_uids } : { location_id });
}

/** An AuthorizationInfo as a CPO receives it: for the mock CPO and tests. */
export function parseAuthorizationInfo(v: unknown): Parsed<AuthorizationInfo> {
  const ctx: Ctx = { errors: [] };
  const o = object(ctx, v, "authorization_info");
  if (!o) return { ok: false, errors: ctx.errors };
  const allowed = oneOf(
    ctx,
    o.allowed,
    "authorization_info.allowed",
    ALLOWED_TYPES,
  );
  const t = token(ctx, o.token, "authorization_info.token");
  const value = { allowed, token: t } as AuthorizationInfo;
  if (o.location !== undefined && o.location !== null) {
    const l = parseLocationReferences(o.location);
    if (l.ok) value.location = l.value;
    else ctx.errors.push(...l.errors);
  }
  const ref = optional(o.authorization_reference, (x) =>
    str(ctx, x, "authorization_info.authorization_reference", 36, ID),
  );
  if (ref) value.authorization_reference = ref;
  if (o.info !== undefined && o.info !== null) {
    const info = displayTexts(ctx, [o.info], "authorization_info.info");
    if (info) value.info = info[0];
  }
  return done(ctx, allowed && t ? value : undefined);
}

export const isTokenType = (v: unknown): v is TokenType =>
  typeof v === "string" && (TOKEN_TYPES as readonly string[]).includes(v);

export const isWhitelistType = (v: unknown): v is WhitelistType =>
  typeof v === "string" && (WHITELIST_TYPES as readonly string[]).includes(v);
