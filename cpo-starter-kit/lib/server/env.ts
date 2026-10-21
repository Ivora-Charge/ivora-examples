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
  get supabaseUrl() {
    return env("SUPABASE_URL") ?? "";
  },
  /** The project's anon (or publishable) key. Used on the server only, with RLS. */
  get supabaseAnonKey() {
    return env("SUPABASE_ANON_KEY") ?? "";
  },
  /** Bypasses RLS. Server-only, for writes that the server has already authorized. */
  get supabaseServiceRoleKey() {
    return env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  },
  /** One-time secret that unlocks the setup screen for the first owner. */
  get setupSecret() {
    return env("SETUP_SECRET") ?? "";
  },
  get resendApiKey() {
    return env("RESEND_API_KEY") ?? "";
  },
  /** Sender for invite and sign-in emails, for example `Team <team@example.com>`. */
  get emailFrom() {
    return env("EMAIL_FROM") ?? "";
  },
  /** Public origin of this deployment, used in invite and sign-in links. */
  get appUrl() {
    const vercel = env("VERCEL_PROJECT_PRODUCTION_URL");
    return (
      env("APP_URL") ?? (vercel ? `https://${vercel}` : "http://localhost:3000")
    ).replace(/\/+$/, "");
  },
};

/** Supabase is configured: staff sign-in, roles and the team live there. */
export function supabaseConfigured(): boolean {
  return Boolean(
    config.supabaseUrl &&
    config.supabaseAnonKey &&
    config.supabaseServiceRoleKey,
  );
}

/**
 * Demo mode: forced with DEMO_MODE=true (or 1), and on whenever live credentials are
 * missing. Live mode needs both Ivora and Supabase, so live charger data is never
 * served without staff sign-in.
 */
export function isDemo(): boolean {
  const forced = env("DEMO_MODE")?.toLowerCase();
  if (forced === "true" || forced === "1") return true;
  return !(config.apiKey && config.tenantId && supabaseConfigured());
}
