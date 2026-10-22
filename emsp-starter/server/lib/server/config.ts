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

/**
 * Payment holds before a start, in minor units per currency, unless HOLD_AMOUNTS says
 * otherwise. A currency without an amount takes no app starts.
 */
export const HOLD_AMOUNTS_DEFAULT: Readonly<Record<string, number>> = {
  EUR: 2500,
  USD: 2500,
  GBP: 2500,
};
/** The largest hold accepted, in minor units: a typo must not hold a fortune. */
export const HOLD_AMOUNT_MAX = 1_000_000;
/** With incremental authorization on: raise the hold at this share of it, in percent. */
export const HOLD_INCREMENT_AT_DEFAULT = 80;

/** Days a Token A we issue stays valid, unless OCPI_TOKEN_A_TTL_DAYS says otherwise. */
export const TOKEN_A_TTL_DAYS_DEFAULT = 7;

/** Shortest ADMIN_SECRET accepted; a shorter one leaves the admin actions disabled. */
export const ADMIN_SECRET_MIN_LENGTH = 32;

const FLAG_ON = new Set(["true", "1", "yes", "on"]);
const CURRENCY = /^[A-Z]{3}$/;

/** `EUR:2500,GBP:2000` as a map, or undefined when any entry is invalid. */
function parseHoldAmounts(v: string): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const part of v.split(",")) {
    const m = /^\s*([A-Za-z]{3})\s*:\s*(\d{1,9})\s*$/.exec(part);
    if (!m) return undefined;
    const amount = Number(m[2]);
    if (amount < 1 || amount > HOLD_AMOUNT_MAX) return undefined;
    out[m[1].toUpperCase()] = amount;
  }
  return out;
}

/** A list of `https://` (or, outside production, `http://localhost`) origins. */
function parseOrigins(v: string): string[] | undefined {
  const out: string[] = [];
  for (const part of v
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(part);
    } catch {
      return undefined;
    }
    const local =
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname) &&
      process.env.NODE_ENV !== "production";
    if ((url.protocol !== "https:" && !local) || url.origin !== part)
      return undefined;
    out.push(url.origin);
  }
  return out;
}

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
  /**
   * Stripe secret (or restricted) key of the network's own Stripe account. Secret.
   * Undefined when unset or not a Stripe secret key: live mode then refuses every
   * payment hold, so no app start goes out unpaid.
   */
  get stripeSecretKey(): string | undefined {
    const v = env("STRIPE_SECRET_KEY");
    return v && /^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(v) ? v : undefined;
  },
  /** Signing secret of the Stripe webhook endpoint. Secret. */
  get stripeWebhookSecret(): string | undefined {
    const v = env("STRIPE_WEBHOOK_SECRET");
    return v && /^whsec_[A-Za-z0-9+/=]+$/.test(v) ? v : undefined;
  },
  /** Stripe publishable key, for the app's PaymentSheet. Public by design. */
  get stripePublishableKey(): string | undefined {
    const v = env("STRIPE_PUBLISHABLE_KEY");
    return v && /^pk_(live|test)_[A-Za-z0-9]+$/.test(v) ? v : undefined;
  },
  /** The payment hold before a start, in minor units, per currency (upper case). */
  get holdAmounts(): Readonly<Record<string, number>> {
    const v = env("HOLD_AMOUNTS");
    return (v && parseHoldAmounts(v)) || HOLD_AMOUNTS_DEFAULT;
  },
  /** The hold's currency when the charger's tariff does not say. */
  get defaultCurrency(): string {
    const v = env("PAYMENT_DEFAULT_CURRENCY")?.toUpperCase();
    return v && CURRENCY.test(v) ? v : "EUR";
  },
  /**
   * Incremental authorization: raise a running session's hold where the card allows
   * it. Off unless STRIPE_INCREMENTAL_AUTH is true, 1, yes or on.
   */
  get incrementalAuth(): { enabled: boolean; atPercent: number } {
    const on = env("STRIPE_INCREMENTAL_AUTH")?.toLowerCase();
    const at = env("HOLD_INCREMENT_AT_PERCENT");
    const n = at && /^\d+$/.test(at) ? Number(at) : NaN;
    return {
      enabled: !!on && FLAG_ON.has(on),
      atPercent: n >= 50 && n <= 95 ? n : HOLD_INCREMENT_AT_DEFAULT,
    };
  },
  /** Resend API key for email receipts. Secret. Unset: no receipts are sent. */
  get resendApiKey(): string | undefined {
    const v = env("RESEND_API_KEY");
    return v && /^re_[A-Za-z0-9_]+$/.test(v) ? v : undefined;
  },
  /** The receipts' sender, for example `Your Network <receipts@example.com>`. */
  get receiptFrom(): string | undefined {
    const v = env("RECEIPT_FROM");
    return v && v.length <= 200 && /@/.test(v) && !/[\r\n]/.test(v)
      ? v
      : undefined;
  },
  /**
   * Expo push access token (expo.dev, Access tokens), for push notifications to the
   * driver app. Secret. Unset: no push is sent.
   */
  get expoAccessToken(): string | undefined {
    const v = env("EXPO_ACCESS_TOKEN");
    return v && /^[A-Za-z0-9_-]{20,200}$/.test(v) ? v : undefined;
  },
  /**
   * Browser origins allowed to call the driver API (the app's web build). Native apps
   * send no Origin and need none. Empty: same origin only.
   */
  get appOrigins(): string[] {
    const v = env("APP_ORIGINS");
    return (v && parseOrigins(v)) || [];
  },
  /** Where the sign-in email's link points, if you send links (see the README). */
  get authRedirectUrl(): string | undefined {
    const v = env("AUTH_REDIRECT_URL");
    if (!v) return undefined;
    try {
      const url = new URL(v);
      return url.protocol === "https:" || url.protocol === "http:"
        ? url.toString()
        : // A native deep link, for example yournetwork://sign-in.
          /^[a-z][a-z0-9+.-]*:$/.test(url.protocol)
          ? url.toString()
          : undefined;
    } catch {
      return undefined;
    }
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
    tokens: `${base}/${OCPI_VERSION}/tokens`,
    commands: `${base}/${OCPI_VERSION}/commands`,
    sessions: `${base}/${OCPI_VERSION}/sessions`,
    cdrs: `${base}/${OCPI_VERSION}/cdrs`,
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
  const optional: [string, () => unknown, string][] = [
    [
      "STRIPE_SECRET_KEY",
      () => config.stripeSecretKey,
      "must be a Stripe secret or restricted key (sk_ or rk_)",
    ],
    [
      "STRIPE_WEBHOOK_SECRET",
      () => config.stripeWebhookSecret,
      "must be a Stripe webhook signing secret (whsec_)",
    ],
    [
      "STRIPE_PUBLISHABLE_KEY",
      () => config.stripePublishableKey,
      "must be a Stripe publishable key (pk_)",
    ],
    [
      "HOLD_AMOUNTS",
      () => parseHoldAmounts(env("HOLD_AMOUNTS")!),
      `must be CURRENCY:minor units pairs, for example EUR:2500,GBP:2000, each 1 to ${HOLD_AMOUNT_MAX}`,
    ],
    [
      "PAYMENT_DEFAULT_CURRENCY",
      () => CURRENCY.test(env("PAYMENT_DEFAULT_CURRENCY")!.toUpperCase()),
      "must be a 3-letter ISO 4217 code",
    ],
    [
      "RESEND_API_KEY",
      () => config.resendApiKey,
      "must be a Resend API key (re_)",
    ],
    [
      "RECEIPT_FROM",
      () => config.receiptFrom,
      "must be an email address, optionally with a name",
    ],
    [
      "EXPO_ACCESS_TOKEN",
      () => config.expoAccessToken,
      "must be an Expo access token (letters, digits, _ and -)",
    ],
    [
      "APP_ORIGINS",
      () => parseOrigins(env("APP_ORIGINS")!),
      "must be comma-separated https:// origins",
    ],
    ["AUTH_REDIRECT_URL", () => config.authRedirectUrl, "must be a URL"],
  ];
  for (const [name, value, message] of optional)
    if (env(name) && !value()) errors.push(`${name} ${message}`);
  const at = env("HOLD_INCREMENT_AT_PERCENT");
  if (at && !(/^\d+$/.test(at) && Number(at) >= 50 && Number(at) <= 95))
    errors.push("HOLD_INCREMENT_AT_PERCENT must be a whole number, 50 to 95");
  const flag = env("STRIPE_INCREMENTAL_AUTH")?.toLowerCase();
  if (flag && !FLAG_ON.has(flag) && !["false", "0", "no", "off"].includes(flag))
    errors.push("STRIPE_INCREMENTAL_AUTH must be on or off");
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
