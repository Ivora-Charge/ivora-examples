import { defineConfig, devices } from "@playwright/test";

const PORT = 3291;

// Runs the built app in demo mode: no credentials, no network beyond localhost.
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  // One server holds the demo clock, so the specs run one at a time.
  workers: 1,
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices["Desktop Chrome"],
    // A Pacific browser against a UTC server (as on Vercel): demo times are depot time either way.
    timezoneId: "America/Los_Angeles",
  },
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    env: {
      DEMO_MODE: "true",
      TZ: "UTC",
      IVORA_API_KEY: "",
      IVORA_TENANT_ID: "",
      OPERATOR_PASSWORD: "",
    },
  },
});
