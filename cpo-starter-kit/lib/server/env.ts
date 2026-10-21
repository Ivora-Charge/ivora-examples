import "server-only";

export const DEFAULT_API_BASE_URL = "https://api.ivoracharge.com";
export const DEFAULT_DASHBOARD_URL = "https://platform.ivoracharge.com";

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
  /**
   * Your Ivora dashboard, where Stripe is connected (API keys can't create Stripe
   * onboarding links). Only an https origin is used.
   */
  get dashboardUrl() {
    const v = env("IVORA_DASHBOARD_URL");
    try {
      if (v && new URL(v).protocol === "https:") return new URL(v).origin;
    } catch {
      // Not a URL: fall back to the default.
    }
    return DEFAULT_DASHBOARD_URL;
  },
  /**
   * Where the "connect Stripe" link goes: the dashboard plus IVORA_DASHBOARD_STRIPE_PATH
   * when set (a path such as /projects/{tenant_id}/settings, with {tenant_id} filled
   * in), else the dashboard home. Only a plain path is used, never another host.
   */
  get stripeSettingsUrl() {
    const path = env("IVORA_DASHBOARD_STRIPE_PATH");
    if (!path || !/^\/[A-Za-z0-9/_.~{}-]*$/.test(path) || path.startsWith("//"))
      return this.dashboardUrl;
    const tenant = /^\d+$/.test(this.tenantId) ? this.tenantId : "";
    if (path.includes("{tenant_id}") && !tenant) return this.dashboardUrl;
    return `${this.dashboardUrl}${path.replaceAll("{tenant_id}", tenant)}`;
  },
  /**
   * Signing secret of this deployment's Ivora webhook endpoint, printed once by
   * `npm run ivora:webhook -- register`. Without it the endpoint refuses deliveries
   * and the Live view relies on polling.
   */
  get webhookSecret() {
    return env("IVORA_WEBHOOK_SECRET") ?? "";
  },
  /**
   * Map tiles for the Live view: an https URL template with {z}, {x} and {y}, needing
   * no API key. Defaults to OpenStreetMap's; MAP_TILE_URL=off shows no tiles.
   */
  get mapTiles(): { url: string; attribution: string; link: string } | null {
    const url = env("MAP_TILE_URL");
    if (url?.toLowerCase() === "off") return null;
    if (!url)
      return {
        url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        attribution: "© OpenStreetMap contributors",
        link: "https://www.openstreetmap.org/copyright",
      };
    if (
      !/^https:\/\/[^\s"'<>]+$/.test(url) ||
      !["{z}", "{x}", "{y}"].every((p) => url.includes(p))
    )
      return null;
    return {
      url,
      attribution: (env("MAP_TILE_ATTRIBUTION") ?? "").slice(0, 200),
      link: /^https:\/\/[^\s"'<>]+$/.test(env("MAP_TILE_ATTRIBUTION_URL") ?? "")
        ? env("MAP_TILE_ATTRIBUTION_URL")!
        : "",
    };
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
  /**
   * Public origin of this deployment, used in invite and sign-in links. A Vercel
   * preview deployment always links to itself, never to production's APP_URL.
   */
  get appUrl() {
    const preview =
      env("VERCEL_ENV") === "preview"
        ? (env("VERCEL_BRANCH_URL") ?? env("VERCEL_URL"))
        : undefined;
    if (preview) return `https://${preview}`.replace(/\/+$/, "");
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
