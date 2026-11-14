import { currencyOr } from "./money";
import "server-only";

/** An empty value counts as unset, so `FOO=` in .env behaves like a missing variable. */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function num(name: string, fallback: number): number {
  const v = Number(env(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * The one rule for an on/off variable: true, 1, yes or on (any case, trimmed) is on;
 * anything else, including empty, is off. Every template parses DEMO_MODE this way.
 */
export function isFlagOn(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

let warnedLegacyApiUrl = false;

/**
 * The Ivora API origin: IVORA_API_URL. The old name IVORA_API_BASE_URL still works
 * for one release and logs a warning once.
 */
function apiUrl(): string | undefined {
  const current = env("IVORA_API_URL");
  if (current) return current;
  const old = env("IVORA_API_BASE_URL");
  if (old && !warnedLegacyApiUrl) {
    warnedLegacyApiUrl = true;
    console.warn(
      "IVORA_API_BASE_URL is deprecated and will be removed in the next release: rename it to IVORA_API_URL.",
    );
  }
  return old;
}

export const config = {
  get apiBase() {
    return (apiUrl() ?? "https://api.ivoracharge.com").replace(/\/+$/, "");
  },
  get apiKey() {
    return env("IVORA_API_KEY") ?? "";
  },
  get tenantId() {
    return env("IVORA_TENANT_ID") ?? "";
  },
  get webhookSecret() {
    return env("IVORA_WEBHOOK_SECRET") ?? "";
  },
  get operatorPassword() {
    return env("OPERATOR_PASSWORD") ?? "";
  },
  get databaseUrl() {
    return env("DATABASE_URL") ?? "";
  },
  get sqlitePath() {
    return env("SQLITE_PATH") ?? "./data/depot.db";
  },
  get siteCapKw() {
    return num("SITE_CAP_KW", 60);
  },
  /** Assumed connector rating when the station does not report one, kW. */
  get defaultConnectorKw() {
    return num("DEFAULT_CONNECTOR_KW", 11);
  },
  /** How often live mode replans without an event, seconds. */
  get replanIntervalSeconds() {
    return num("REPLAN_INTERVAL_SECONDS", 60);
  },
  /** Opt-in: a per-charger baseline profile that covers the plug-in gap (live mode only). */
  get baselineProfile() {
    return isFlagOn(env("BASELINE_PROFILE"));
  },
  get centsPerKwh() {
    return Math.round(num("TARIFF_CENTS_PER_KWH", 28));
  },
  get currency() {
    return currencyOr(env("TARIFF_CURRENCY"));
  },
};

/** Demo mode runs offline with simulated data. It is on unless both credentials are set. */
export const isDemo = () => {
  if (isFlagOn(env("DEMO_MODE"))) return true;
  return !(config.apiKey && config.tenantId);
};
