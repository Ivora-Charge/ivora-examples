import { defineConfig, devices } from "@playwright/test";

const PORT = 3317;
export const E2E_ADMIN_SECRET = "e2e-only-admin-secret-0123456789abcdef";

/**
 * The same build under six synthetic configurations, so that e2e/signed-out.spec.ts
 * can compare what each sends to a visitor who is not signed in. Every value is made
 * up for this offline run: none is a credential, and no server here is ever asked to
 * reach the hosts named. The servers out of demo mode are started with
 * e2e/fake-database.mjs, which answers their database requests in process.
 *
 * In demo mode (no database; no admin can exist, so Setup shows a visitor the public
 * view: six names, none done):
 * - "demo": the server every other spec uses. Demo mode by DEMO_MODE, defaults.
 * - "misconfigured": every live-mode setting unset and optional ones malformed. It is
 *   in demo mode for that reason alone.
 * - "demo-full": everything set and well formed (an address, an identity, payments,
 *   email, the job) but the admin secret, kept in demo mode by DEMO_MODE.
 *
 * Not in demo mode:
 * - "live-a", "live-b": everything well formed, with different addresses and
 *   identities. One has payments, the job and the admin secret set, the other has
 *   none of them. Neither database has an admin yet, and what the two hold differs
 *   (peers, times, events), but the same stops pass.
 * - "live-admin": "live-a" again with a database that has an admin.
 */
const fake = (prefix: string, fill: string) => prefix + fill.repeat(6);
const LIVE_A = {
  EMSP_COUNTRY_CODE: "NL",
  EMSP_PARTY_ID: "QRS",
  PUBLIC_BASE_URL: "https://charge.example.org",
  SUPABASE_URL: "https://db-one.example.org",
  SUPABASE_SERVICE_ROLE_KEY: "e2e-not-a-key-one",
  OCPI_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  STRIPE_SECRET_KEY: fake("sk_" + "test_", "e2eA"),
  STRIPE_WEBHOOK_SECRET: fake("whsec_", "e2eB"),
  HOLD_AMOUNTS: "EUR:3000,GBP:2000",
  RESEND_API_KEY: fake("re_", "e2eC"),
  CRON_SECRET: fake("", "e2e-cron-"),
  ADMIN_SECRET: E2E_ADMIN_SECRET,
};
const LIVE_B = {
  EMSP_COUNTRY_CODE: "DE",
  EMSP_PARTY_ID: "X7Z",
  PUBLIC_BASE_URL: "https://emsp.example.net",
  SUPABASE_URL: "https://db-two.example.net",
  SUPABASE_SERVICE_ROLE_KEY: "e2e-not-a-key-two",
  OCPI_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
  STRIPE_SECRET_KEY: "",
  STRIPE_WEBHOOK_SECRET: "",
  HOLD_AMOUNTS: "",
  RESEND_API_KEY: "",
  CRON_SECRET: "",
  ADMIN_SECRET: "",
};
const MISCONFIGURED = {
  EMSP_COUNTRY_CODE: "",
  EMSP_PARTY_ID: "",
  PUBLIC_BASE_URL: "",
  SUPABASE_URL: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  OCPI_TOKEN_ENCRYPTION_KEY: "",
  STRIPE_SECRET_KEY: "bad",
  STRIPE_WEBHOOK_SECRET: "bad",
  HOLD_AMOUNTS: "bad",
  RESEND_API_KEY: "bad",
  CRON_SECRET: "",
  ADMIN_SECRET: E2E_ADMIN_SECRET,
};

const LIVE_ADMIN = { ...LIVE_A, SUPABASE_URL: "https://db-three.example.org" };

export type Setup = {
  name: string;
  url: string;
  mode: "demo" | "live";
  /** ADMIN_SECRET is set: the one thing the sign-in page says about the settings. */
  secret: boolean;
  /** An admin exists, so a visitor gets no public view of Setup. Never in demo mode. */
  admin: boolean;
  env: Record<string, string>;
};
/** The database stand-in, loaded into the servers that are not in demo mode. */
const FAKE_DATABASE = "--import=./e2e/fake-database.mjs";
export const SETUPS: Setup[] = [
  {
    name: "demo",
    mode: "demo",
    secret: true,
    // ADMIN_SECRET is a fixed test value, only for this offline run.
    env: {
      DEMO_MODE: "true",
      SUPABASE_SERVICE_ROLE_KEY: "",
      ADMIN_SECRET: E2E_ADMIN_SECRET,
    },
  },
  { name: "misconfigured", mode: "demo", secret: true, env: MISCONFIGURED },
  {
    name: "demo-full",
    mode: "demo",
    secret: false,
    env: { ...LIVE_A, ADMIN_SECRET: "", DEMO_MODE: "true" },
  },
  { name: "live-a", mode: "live", secret: true, env: LIVE_A },
  { name: "live-b", mode: "live", secret: false, env: LIVE_B },
  {
    name: "live-admin",
    mode: "live",
    secret: true,
    admin: true,
    env: LIVE_ADMIN,
  },
].map((setup, i) => ({
  admin: false,
  ...setup,
  mode: setup.mode as Setup["mode"],
  url: `http://localhost:${PORT + i}`,
  env: {
    // Only the first is in demo mode because it was asked to be.
    DEMO_MODE: "",
    ...(setup.mode === "live" ? { NODE_OPTIONS: FAKE_DATABASE } : {}),
    ...setup.env,
  },
}));

// Runs the built admin web in demo mode: no credentials, no network beyond localhost.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL: SETUPS[0].url },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: SETUPS.map((setup) => ({
    command: `npx next start -p ${new URL(setup.url).port}`,
    url: setup.url,
    reuseExistingServer: false,
    env: setup.env,
  })),
});
