import "server-only";

type Env = Record<string, string | undefined>;

export const ERRORS_URL =
  "https://ivoracharge.com/developers/guides/reference/errors";
export const DEFAULT_API_URL = "https://api.ivoracharge.com";

/**
 * The one rule for an on/off variable: true, 1, yes or on (any case, trimmed) is on;
 * anything else, including empty, is off. Every template parses DEMO_MODE this way.
 */
export function isFlagOn(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

/** Demo mode: forced with DEMO_MODE=true (or 1, yes, on), or whenever live credentials are missing. */
export function isDemo(env: Env = process.env): boolean {
  return isFlagOn(env.DEMO_MODE) || !env.IVORA_API_KEY || !env.IVORA_TENANT_ID;
}

let warnedLegacyApiUrl = false;

/**
 * IVORA_API_BASE_URL is the old name of IVORA_API_URL. It still works for one
 * release and logs a warning once.
 */
function apiUrl(env: Env): string {
  const current = env.IVORA_API_URL?.trim();
  if (current) return current;
  const old = env.IVORA_API_BASE_URL?.trim();
  if (old && !warnedLegacyApiUrl) {
    warnedLegacyApiUrl = true;
    console.warn(
      "IVORA_API_BASE_URL is deprecated and will be removed in the next release: rename it to IVORA_API_URL.",
    );
  }
  return old || DEFAULT_API_URL;
}

export type LiveConfig = { apiKey: string; tenantId: string; origin: string };

export function liveConfig(env: Env = process.env): LiveConfig {
  const apiKey = env.IVORA_API_KEY ?? "";
  const tenantId = env.IVORA_TENANT_ID ?? "";
  if (!apiKey) throw new Error("Missing IVORA_API_KEY.");
  if (!/^\d+$/.test(tenantId) || Number(tenantId) < 1)
    throw new Error("IVORA_TENANT_ID must be your numeric tenant ID.");
  const url = new URL(apiUrl(env));
  if (url.protocol !== "https:")
    throw new Error("IVORA_API_URL must use https://.");
  return { apiKey, tenantId, origin: url.origin };
}
