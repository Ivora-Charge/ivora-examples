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

export const config = {
  get apiBase() {
    return (env("IVORA_API_BASE_URL") ?? "https://api.ivoracharge.com").replace(
      /\/+$/,
      "",
    );
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
    const v = env("BASELINE_PROFILE");
    return v === "1" || v === "true";
  },
  get centsPerKwh() {
    return Math.round(num("TARIFF_CENTS_PER_KWH", 28));
  },
  get currency() {
    return env("TARIFF_CURRENCY") ?? "EUR";
  },
};

/** Demo mode runs offline with simulated data. It is on unless both credentials are set. */
export const isDemo = () => {
  const forced = env("DEMO_MODE");
  if (forced === "true" || forced === "1") return true;
  return !(config.apiKey && config.tenantId);
};
