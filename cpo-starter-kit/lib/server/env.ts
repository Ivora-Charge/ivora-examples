import "server-only";

export const DEFAULT_API_BASE_URL = "https://api.ivoracharge.com";

/** An empty value counts as unset, so `FOO=` in .env behaves like a missing variable. */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

/** Server-side settings. Read on every call so tests and restarts see the current env. */
export const config = {
  get apiBaseUrl() {
    return (env("IVORA_API_BASE_URL") ?? DEFAULT_API_BASE_URL).replace(
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
  /** Shown in the header and page titles. */
  get operatorName() {
    return env("OPERATOR_NAME") ?? "Your charging network";
  },
};

/** Demo mode: forced with DEMO_MODE=true (or 1), and on whenever live credentials are missing. */
export function isDemo(): boolean {
  const forced = env("DEMO_MODE")?.toLowerCase();
  if (forced === "true" || forced === "1") return true;
  return !(config.apiKey && config.tenantId);
}
