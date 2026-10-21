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
  /** Stripe connected account of the site operator; empty when the deployer runs the site. */
  stripeConnectedAccount: string;
  /** Drivers may pay at the counter: on in demo mode, or when CASHIER_PASSWORD is set. */
  payInStore: boolean;
};

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
  const demo = env.DEMO_MODE === "1" || missing.length > 0;
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
  return {
    demo,
    missing: env.DEMO_MODE === "1" ? ["DEMO_MODE=1"] : [...missing],
    ivoraApiUrl: (env.IVORA_API_URL || "https://api.ivoracharge.com").trim(),
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
    stripeConnectedAccount: env.STRIPE_CONNECTED_ACCOUNT_ID?.trim() ?? "",
    payInStore: demo || Boolean(env.CASHIER_PASSWORD?.trim()),
  };
}
