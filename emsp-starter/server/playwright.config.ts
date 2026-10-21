import { defineConfig, devices } from "@playwright/test";

const PORT = 3317;
export const E2E_ADMIN_SECRET = "e2e-only-admin-secret-0123456789abcdef";

// Runs the built admin web in demo mode: no credentials, no network beyond localhost.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
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
});
