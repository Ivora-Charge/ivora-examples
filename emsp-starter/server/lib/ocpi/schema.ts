import {
  ROLES,
  type BusinessDetails,
  type Credentials,
  type CredentialsRole,
  type Endpoint,
  type Envelope,
  type Image,
  type Role,
  type Version,
  type VersionDetails,
} from "./types";

/**
 * Validators for incoming OCPI 2.2.1 objects. Each returns the object with only the
 * fields the spec defines (unknown fields are dropped), or a list of problems. Messages
 * name fields, never values, so they are safe to log and to return to the peer.
 */
export type Parsed<T> =
  { ok: true; value: T } | { ok: false; errors: string[] };

type Ctx = { errors: string[] };
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function str(
  ctx: Ctx,
  v: unknown,
  path: string,
  max: number,
  pattern?: RegExp,
): string | undefined {
  if (typeof v !== "string" || v.length === 0 || v.length > max) {
    ctx.errors.push(`${path} must be a string of 1 to ${max} characters`);
    return undefined;
  }
  if (pattern && !pattern.test(v)) {
    ctx.errors.push(`${path} has an invalid format`);
    return undefined;
  }
  return v;
}

function optional<T>(
  v: unknown,
  check: (v: unknown) => T | undefined,
): T | undefined {
  return v === undefined || v === null ? undefined : check(v);
}

function url(
  ctx: Ctx,
  v: unknown,
  path: string,
  { httpsOnly }: { httpsOnly: boolean },
): string | undefined {
  const s = str(ctx, v, path, 255);
  if (s === undefined) return undefined;
  let parsed: URL | undefined;
  try {
    parsed = new URL(s);
  } catch {}
  const allowed = httpsOnly ? ["https:"] : ["https:", "http:"];
  if (!parsed || !allowed.includes(parsed.protocol) || parsed.username) {
    ctx.errors.push(
      `${path} must be an ${httpsOnly ? "https" : "http(s)"} URL`,
    );
    return undefined;
  }
  return s;
}

function array<T>(
  ctx: Ctx,
  v: unknown,
  path: string,
  item: (v: unknown, path: string) => T | undefined,
  { min = 0, max = 1000 } = {},
): T[] | undefined {
  if (!Array.isArray(v) || v.length < min || v.length > max) {
    ctx.errors.push(`${path} must be an array of ${min} to ${max} items`);
    return undefined;
  }
  const out: T[] = [];
  v.forEach((x, i) => {
    const r = item(x, `${path}[${i}]`);
    if (r !== undefined) out.push(r);
  });
  return out.length === v.length ? out : undefined;
}

function object(
  ctx: Ctx,
  v: unknown,
  path: string,
): Record<string, unknown> | undefined {
  if (!isObject(v)) {
    ctx.errors.push(`${path} must be an object`);
    return undefined;
  }
  return v;
}

function done<T>(ctx: Ctx, value: T | undefined): Parsed<T> {
  return ctx.errors.length === 0 && value !== undefined
    ? { ok: true, value }
    : { ok: false, errors: ctx.errors.length ? ctx.errors : ["invalid"] };
}

/** A token as OCPI sends it: string(64), printable ASCII without spaces. */
export const TOKEN_PATTERN = /^[\x21-\x7e]{1,64}$/;
const COUNTRY = /^[A-Za-z]{2}$/;
const PARTY = /^[A-Za-z0-9]{3}$/;
const VERSION_NUMBER = /^\d{1,2}(\.\d{1,2}){0,2}$/;
const MODULE_ID = /^[a-z_]{1,50}$/;

function image(ctx: Ctx, v: unknown, path: string): Image | undefined {
  const o = object(ctx, v, path);
  if (!o) return undefined;
  const dim = (x: unknown, p: string) => {
    if (Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 99999)
      return x as number;
    ctx.errors.push(`${p} must be a whole number of pixels`);
    return undefined;
  };
  const value: Image = {
    url: url(ctx, o.url, `${path}.url`, { httpsOnly: false }) ?? "",
    category: str(ctx, o.category, `${path}.category`, 20) ?? "",
    type: str(ctx, o.type, `${path}.type`, 4) ?? "",
  };
  const thumbnail = optional(o.thumbnail, (x) =>
    url(ctx, x, `${path}.thumbnail`, { httpsOnly: false }),
  );
  const width = optional(o.width, (x) => dim(x, `${path}.width`));
  const height = optional(o.height, (x) => dim(x, `${path}.height`));
  if (thumbnail) value.thumbnail = thumbnail;
  if (width !== undefined) value.width = width;
  if (height !== undefined) value.height = height;
  return value;
}

function businessDetails(
  ctx: Ctx,
  v: unknown,
  path: string,
): BusinessDetails | undefined {
  const o = object(ctx, v, path);
  if (!o) return undefined;
  const value: BusinessDetails = {
    name: str(ctx, o.name, `${path}.name`, 100) ?? "",
  };
  const website = optional(o.website, (x) =>
    url(ctx, x, `${path}.website`, { httpsOnly: false }),
  );
  const logo = optional(o.logo, (x) => image(ctx, x, `${path}.logo`));
  if (website) value.website = website;
  if (logo) value.logo = logo;
  return value;
}

function credentialsRole(
  ctx: Ctx,
  v: unknown,
  path: string,
): CredentialsRole | undefined {
  const o = object(ctx, v, path);
  if (!o) return undefined;
  if (!ROLES.includes(o.role as Role)) {
    ctx.errors.push(`${path}.role must be one of ${ROLES.join(", ")}`);
    return undefined;
  }
  const before = ctx.errors.length;
  const business_details = businessDetails(
    ctx,
    o.business_details,
    `${path}.business_details`,
  );
  const party_id = str(ctx, o.party_id, `${path}.party_id`, 3, PARTY);
  const country_code = str(
    ctx,
    o.country_code,
    `${path}.country_code`,
    2,
    COUNTRY,
  );
  if (ctx.errors.length > before || !business_details) return undefined;
  return {
    role: o.role as Role,
    business_details,
    // CiString: compare and store upper case.
    party_id: party_id!.toUpperCase(),
    country_code: country_code!.toUpperCase(),
  };
}

/** The credentials object a peer POSTs or PUTs to us, or returns to our POST or PUT. */
export function parseCredentials(v: unknown): Parsed<Credentials> {
  const ctx: Ctx = { errors: [] };
  const o = object(ctx, v, "credentials");
  if (!o) return { ok: false, errors: ctx.errors };
  const token = str(ctx, o.token, "credentials.token", 64, TOKEN_PATTERN);
  const u = url(ctx, o.url, "credentials.url", { httpsOnly: true });
  const roles = array(
    ctx,
    o.roles,
    "credentials.roles",
    (x, p) => credentialsRole(ctx, x, p),
    { min: 1, max: 50 },
  );
  const seen = new Set<string>();
  for (const r of roles ?? []) {
    const key = `${r.role}:${r.country_code}:${r.party_id}`;
    if (seen.has(key)) ctx.errors.push("credentials.roles has duplicates");
    seen.add(key);
  }
  return done(ctx, token && u && roles ? { token, url: u, roles } : undefined);
}

/** The data of a versions endpoint response. */
export function parseVersions(v: unknown): Parsed<Version[]> {
  const ctx: Ctx = { errors: [] };
  const list = array(
    ctx,
    v,
    "versions",
    (x, p) => {
      const o = object(ctx, x, p);
      if (!o) return undefined;
      const version = str(ctx, o.version, `${p}.version`, 10, VERSION_NUMBER);
      const u = url(ctx, o.url, `${p}.url`, { httpsOnly: true });
      return version && u ? { version, url: u } : undefined;
    },
    { min: 1, max: 20 },
  );
  return done(ctx, list);
}

/** The data of a version details endpoint response. */
export function parseVersionDetails(v: unknown): Parsed<VersionDetails> {
  const ctx: Ctx = { errors: [] };
  const o = object(ctx, v, "version_details");
  if (!o) return { ok: false, errors: ctx.errors };
  const version = str(
    ctx,
    o.version,
    "version_details.version",
    10,
    VERSION_NUMBER,
  );
  const endpoints = array(
    ctx,
    o.endpoints,
    "version_details.endpoints",
    (x, p): Endpoint | undefined => {
      const e = object(ctx, x, p);
      if (!e) return undefined;
      const identifier = str(
        ctx,
        e.identifier,
        `${p}.identifier`,
        50,
        MODULE_ID,
      );
      if (e.role !== "SENDER" && e.role !== "RECEIVER") {
        ctx.errors.push(`${p}.role must be SENDER or RECEIVER`);
        return undefined;
      }
      const u = url(ctx, e.url, `${p}.url`, { httpsOnly: true });
      return identifier && u ? { identifier, role: e.role, url: u } : undefined;
    },
    { min: 1, max: 100 },
  );
  return done(ctx, version && endpoints ? { version, endpoints } : undefined);
}

/** The OCPI response envelope: status_code and timestamp are required. */
export function parseEnvelope(v: unknown): Parsed<Envelope> {
  const ctx: Ctx = { errors: [] };
  const o = object(ctx, v, "response");
  if (!o) return { ok: false, errors: ctx.errors };
  if (
    !Number.isInteger(o.status_code) ||
    (o.status_code as number) < 1000 ||
    (o.status_code as number) > 9999
  )
    ctx.errors.push("response.status_code must be a 4-digit integer");
  if (typeof o.timestamp !== "string" || Number.isNaN(Date.parse(o.timestamp)))
    ctx.errors.push("response.timestamp must be a DateTime");
  if (o.status_message !== undefined && typeof o.status_message !== "string")
    ctx.errors.push("response.status_message must be a string");
  if (ctx.errors.length) return { ok: false, errors: ctx.errors };
  const value: Envelope = {
    status_code: o.status_code as number,
    timestamp: o.timestamp as string,
  };
  if ("data" in o) value.data = o.data;
  if (typeof o.status_message === "string")
    value.status_message = o.status_message;
  return done(ctx, value);
}
