import "server-only";

type Env = Record<string, string | undefined>;

export const ERRORS_URL =
  "https://ivoracharge.com/developers/guides/reference/errors";
export const DEFAULT_API_URL = "https://api.ivoracharge.com";

/** Demo mode: forced with DEMO_MODE=1, or whenever live credentials are missing. */
export function isDemo(env: Env = process.env): boolean {
  return env.DEMO_MODE === "1" || !env.IVORA_API_KEY || !env.IVORA_TENANT_ID;
}

export type LiveConfig = { apiKey: string; tenantId: string; origin: string };

export function liveConfig(env: Env = process.env): LiveConfig {
  const apiKey = env.IVORA_API_KEY ?? "";
  const tenantId = env.IVORA_TENANT_ID ?? "";
  if (!apiKey) throw new Error("Missing IVORA_API_KEY.");
  if (!/^\d+$/.test(tenantId) || Number(tenantId) < 1)
    throw new Error("IVORA_TENANT_ID must be your numeric tenant ID.");
  const url = new URL(env.IVORA_API_URL || DEFAULT_API_URL);
  if (url.protocol !== "https:")
    throw new Error("IVORA_API_URL must use https://.");
  return { apiKey, tenantId, origin: url.origin };
}
