import { defineConfig, devices } from "@playwright/test";

const PORT = 3317;
export const E2E_ADMIN_SECRET = "e2e-only-admin-secret-0123456789abcdef";

/**
 * A second copy of the server whose settings are wrong: every live-mode setting unset
 * and optional ones malformed. It is in demo mode for that reason alone. The values are
 * fixed nonsense, none is a credential. e2e/signed-out.spec.ts reads what this server
 * sends to a visitor who is not signed in.
 */
const MISCONFIGURED_PORT = 3318;
export const MISCONFIGURED_URL = `http://localhost:${MISCONFIGURED_PORT}`;
export const MISCONFIGURED_ENV = {
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
};

// Runs the built admin web in demo mode: no credentials, no network beyond localhost.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: `npx next start -p ${PORT}`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: false,
      // ADMIN_SECRET is a fixed test value, only for this offline run.
      env: {
        DEMO_MODE: "true",
        SUPABASE_SERVICE_ROLE_KEY: "",
        ADMIN_SECRET: E2E_ADMIN_SECRET,
      },
    },
    {
      // The same build as a deployment set up wrongly: see MISCONFIGURED_URL.
      command: `npx next start -p ${MISCONFIGURED_PORT}`,
      url: MISCONFIGURED_URL,
      reuseExistingServer: false,
      env: {
        ...MISCONFIGURED_ENV,
        DEMO_MODE: "",
        ADMIN_SECRET: E2E_ADMIN_SECRET,
      },
    },
  ],
});
