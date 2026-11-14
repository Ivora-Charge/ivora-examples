import { parseBasisPoints, parseCents } from "./money";

/** The portal page every API error links to. */
export const ERRORS_URL =
  "https://ivoracharge.com/developers/guides/reference/errors";

export type Settings = {
  demo: boolean;
  /** Variables that put the app in demo mode, by name only. */
  missing: string[];
  ivoraApiUrl: string;
  /** Deployer's application fee on each captured payment, in basis points (1000 = 10%). */
  applicationFeeBps: number;
  /** Card hold when a charger's tariff has no authorization amount, in cents. */
  defaultHoldCents: number;
  /** Free idle minutes after charging ends; the app waives idle fees inside them. */
  idleGraceMinutes: number;
  typicalSessionKwh: number;
  typicalSessionMinutes: number;
  siteTimeZone: string;
  publicBaseUrl: string;
  /**
   * The Ivora tenant (project) ID, from IVORA_TENANT_ID; empty in demo mode. Card
   * checkouts are tagged with it, so the hold sweep only releases this deployment's
   * holds when several share one Stripe account.
   */
  tenantId: string;
  /** Stripe connected account of the site operator; empty when the deployer runs the site. */
  stripeConnectedAccount: string;
  /** Drivers may pay at the counter: on in demo mode, or when CASHIER_PASSWORD is set. */
  payInStore: boolean;
  /**
   * Where the signed `session_due` webhook goes (pay in store); empty when
   * off. Always empty in demo mode, which never sends it.
   */
  posWebhookUrl: string;
  /** Emailed store receipts: previewed in demo mode, sent when an email provider is set up. */
  emailReceipts: boolean;
};

/**
 * The one rule for an on/off variable: true, 1, yes or on (any case, trimmed) is on;
 * anything else, including empty, is off. Every template parses DEMO_MODE this way.
 */
export function isFlagOn(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

/** The demo notice: "DEMO_MODE is set" when forced, else the live variables still missing. */
export function demoNotice(s: Pick<Settings, "missing">): string {
  return s.missing.includes("DEMO_MODE")
    ? "DEMO_MODE is set."
    : `Live mode also needs: ${s.missing.join(", ")}`;
}

/** Live mode needs all of these. Any missing one keeps the app in demo mode. */
export const LIVE_VARIABLES = [
  "IVORA_API_KEY",
  "IVORA_TENANT_ID",
  "STRIPE_SECRET_KEY",
  "SESSION_SECRET",
  "OPERATOR_PASSWORD",
  "PUBLIC_BASE_URL",
] as const;

// Stripe can't collect less than 50 cents in USD; holds above $500 are out of scope.
export const MIN_HOLD_CENTS = 50;
export const MAX_HOLD_CENTS = 50_000;

function integer(raw: string | undefined, fallback: number, name: string) {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim()))
    throw new Error(`${name} must be a whole number.`);
  return Number(raw.trim());
}

export function readSettings(
  env: Record<string, string | undefined> = process.env,
): Settings {
  const missing = LIVE_VARIABLES.filter((name) => !env[name]?.trim());
  const forced = isFlagOn(env.DEMO_MODE);
  const demo = forced || missing.length > 0;
  const holdRaw = env.DEFAULT_HOLD_CENTS?.trim() || "5000";
  const defaultHoldCents = parseCents(holdRaw, "DEFAULT_HOLD_CENTS");
  if (defaultHoldCents < MIN_HOLD_CENTS || defaultHoldCents > MAX_HOLD_CENTS)
    throw new Error(
      `DEFAULT_HOLD_CENTS must be between ${MIN_HOLD_CENTS} and ${MAX_HOLD_CENTS}.`,
    );
  const publicBaseUrl = (env.PUBLIC_BASE_URL || "http://localhost:3000")
    .trim()
    .replace(/\/+$/, "");
  if (!demo) {
    const url = new URL(publicBaseUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost")
      throw new Error("PUBLIC_BASE_URL must use HTTPS.");
  }
  const posWebhookUrl = demo ? "" : webhookUrl(env.POS_WEBHOOK_URL);
  return {
    demo,
    missing: forced ? ["DEMO_MODE"] : [...missing],
    ivoraApiUrl: (
      env.IVORA_API_URL?.trim() ||
      legacyApiUrl(env) ||
      "https://api.ivoracharge.com"
    ).trim(),
    applicationFeeBps: parseBasisPoints(env.APPLICATION_FEE_BPS ?? "1000"),
    defaultHoldCents,
    idleGraceMinutes: integer(env.IDLE_GRACE_MINUTES, 10, "IDLE_GRACE_MINUTES"),
    typicalSessionKwh: integer(
      env.TYPICAL_SESSION_KWH,
      30,
      "TYPICAL_SESSION_KWH",
    ),
    typicalSessionMinutes: integer(
      env.TYPICAL_SESSION_MINUTES,
      25,
      "TYPICAL_SESSION_MINUTES",
    ),
    siteTimeZone: env.SITE_TIME_ZONE?.trim() || "UTC",
    publicBaseUrl,
    tenantId: env.IVORA_TENANT_ID?.trim() ?? "",
    stripeConnectedAccount: env.STRIPE_CONNECTED_ACCOUNT_ID?.trim() ?? "",
    payInStore: demo || Boolean(env.CASHIER_PASSWORD?.trim()),
    posWebhookUrl,
    emailReceipts:
      demo ||
      (Boolean(env.RESEND_API_KEY?.trim()) &&
        Boolean(env.RECEIPT_EMAIL_FROM?.trim())),
  };
}

/** POS_WEBHOOK_URL: HTTPS (plain HTTP only for localhost), with no credentials in it. */
function webhookUrl(raw: string | undefined) {
  const value = raw?.trim() ?? "";
  if (!value) return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("POS_WEBHOOK_URL must be a URL.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error("POS_WEBHOOK_URL must use HTTPS.");
  if (url.username || url.password)
    throw new Error(
      "POS_WEBHOOK_URL must not contain credentials; the webhook is signed with POS_WEBHOOK_SECRET.",
    );
  return url.toString();
}

let warnedLegacyApiUrl = false;

/**
 * IVORA_API_BASE_URL is the old name of IVORA_API_URL. It still works for one
 * release and logs a warning once.
 */
function legacyApiUrl(env: Record<string, string | undefined>): string {
  const old = env.IVORA_API_BASE_URL?.trim() ?? "";
  if (old && !warnedLegacyApiUrl) {
    warnedLegacyApiUrl = true;
    console.warn(
      "IVORA_API_BASE_URL is deprecated and will be removed in the next release: rename it to IVORA_API_URL.",
    );
  }
  return old;
}
