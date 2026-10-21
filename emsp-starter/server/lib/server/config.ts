import "server-only";

/** OCPI version this eMSP implements. */
export const OCPI_VERSION = "2.2.1";

/** Identity used in demo mode, when EMSP_COUNTRY_CODE / EMSP_PARTY_ID are unset. */
export const DEMO_PARTY = { countryCode: "ZZ", partyId: "DMO" } as const;

/** An empty value counts as unset, so `FOO=` in .env behaves like a missing variable. */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

/**
 * Variables live mode needs. If any is missing, the server runs in demo mode.
 * OCPI peer credentials are not here: they are exchanged with each CPO through the
 * OCPI credentials module and stored in the database.
 */
export const LIVE_REQUIRED = [
  "EMSP_COUNTRY_CODE",
  "EMSP_PARTY_ID",
  "PUBLIC_BASE_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OCPI_TOKEN_ENCRYPTION_KEY",
] as const;

/** Days a Token A we issue stays valid, unless OCPI_TOKEN_A_TTL_DAYS says otherwise. */
export const TOKEN_A_TTL_DAYS_DEFAULT = 7;

/** Shortest ADMIN_SECRET accepted; a shorter one leaves the admin actions disabled. */
export const ADMIN_SECRET_MIN_LENGTH = 32;

/**
 * Server-side settings, read on every call so tests and restarts see the current
 * environment. Secrets (`supabaseServiceRoleKey`) must never be logged, returned from
 * an API or passed to a client component; use `publicSummary()` for anything shown.
 */
export const config = {
  /** ISO 3166-1 alpha-2 country code of this eMSP, upper case. */
  get countryCode(): string {
    return env("EMSP_COUNTRY_CODE")?.toUpperCase() ?? DEMO_PARTY.countryCode;
  },
  /** OCPI party ID of this eMSP (3 characters), upper case. */
  get partyId(): string {
    return env("EMSP_PARTY_ID")?.toUpperCase() ?? DEMO_PARTY.partyId;
  },
  /** HTTPS origin this server is reached at, used for the OCPI versions URL. */
  get publicBaseUrl(): string {
    return (env("PUBLIC_BASE_URL") ?? "http://localhost:3000").replace(
      /\/+$/,
      "",
    );
  },
  get supabaseUrl(): string {
    return env("SUPABASE_URL") ?? "";
  },
  get supabaseServiceRoleKey(): string {
    return env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  },
  /**
   * 32-byte key (base64) that encrypts the tokens CPO peers give us, at rest. Secret.
   * Undefined when unset or not 32 bytes.
   */
  get tokenEncryptionKey(): Buffer | undefined {
    const raw = env("OCPI_TOKEN_ENCRYPTION_KEY");
    if (!raw || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return undefined;
    const key = Buffer.from(raw, "base64");
    return key.length === 32 ? key : undefined;
  },
  /**
   * Days a Token A (an invitation for a CPO to register) stays valid: 1 to 90, default
   * 7. An invalid value falls back to the default and is reported by configErrors().
   */
  get tokenATtlDays(): number {
    const v = env("OCPI_TOKEN_A_TTL_DAYS");
    if (!v) return TOKEN_A_TTL_DAYS_DEFAULT;
    const n = /^\d+$/.test(v) ? Number(v) : NaN;
    return n >= 1 && n <= 90 ? n : TOKEN_A_TTL_DAYS_DEFAULT;
  },
  /**
   * Temporary gate for the admin actions until admin sign-in lands. Secret. Undefined
   * when unset or shorter than ADMIN_SECRET_MIN_LENGTH, which disables the actions.
   */
  get adminSecret(): string | undefined {
    const v = env("ADMIN_SECRET");
    return v && v.length >= ADMIN_SECRET_MIN_LENGTH ? v : undefined;
  },
  /**
   * Bearer secret for the scheduled pull (`/api/cron/ocpi-sync`). Secret. Undefined
   * when unset or shorter than ADMIN_SECRET_MIN_LENGTH, which disables the route.
   */
  get cronSecret(): string | undefined {
    const v = env("CRON_SECRET");
    return v && v.length >= ADMIN_SECRET_MIN_LENGTH ? v : undefined;
  },
};

/** Where CPO peers reach this eMSP's OCPI endpoints. */
export function ocpiUrls() {
  const base = `${config.publicBaseUrl}/ocpi`;
  return {
    versions: `${base}/versions`,
    details: `${base}/${OCPI_VERSION}`,
    credentials: `${base}/${OCPI_VERSION}/credentials`,
    locations: `${base}/${OCPI_VERSION}/locations`,
    tariffs: `${base}/${OCPI_VERSION}/tariffs`,
  };
}

/** Names (never values) of live-mode variables that are unset. */
export function missingForLive(): string[] {
  return LIVE_REQUIRED.filter((name) => !env(name));
}

/** Problems with the values that are set. Messages name variables, never values. */
export function configErrors(): string[] {
  const errors: string[] = [];
  if (env("EMSP_COUNTRY_CODE") && !/^[A-Z]{2}$/.test(config.countryCode))
    errors.push("EMSP_COUNTRY_CODE must be a 2-letter ISO 3166-1 code");
  if (env("EMSP_PARTY_ID") && !/^[A-Z0-9]{3}$/.test(config.partyId))
    errors.push("EMSP_PARTY_ID must be 3 letters or digits");
  if (env("PUBLIC_BASE_URL")) {
    let url: URL | undefined;
    try {
      url = new URL(config.publicBaseUrl);
    } catch {}
    if (url?.protocol !== "https:")
      errors.push("PUBLIC_BASE_URL must be an https:// origin");
  }
  if (env("SUPABASE_URL")) {
    let ok = false;
    try {
      ok = new URL(config.supabaseUrl).protocol === "https:";
    } catch {}
    if (!ok) errors.push("SUPABASE_URL must be an https:// URL");
  }
  if (env("OCPI_TOKEN_ENCRYPTION_KEY") && !config.tokenEncryptionKey)
    errors.push("OCPI_TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  const ttl = env("OCPI_TOKEN_A_TTL_DAYS");
  if (ttl && !(/^\d+$/.test(ttl) && Number(ttl) >= 1 && Number(ttl) <= 90))
    errors.push(
      "OCPI_TOKEN_A_TTL_DAYS must be a whole number of days, 1 to 90",
    );
  return errors;
}

/** Safe to show in the admin web and return from the API: no secrets. */
export function publicSummary() {
  return {
    ocpiVersion: OCPI_VERSION,
    countryCode: config.countryCode,
    partyId: config.partyId,
  };
}
