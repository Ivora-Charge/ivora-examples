import { defineConfig, devices } from "@playwright/test";

const PORT = 3217;

// Runs the built app in demo mode: no credentials, no network beyond localhost.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL: `http://localhost:${PORT}`, ...devices["Desktop Chrome"] },
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    env: {
      DEMO_MODE: "1",
      IVORA_API_KEY: "",
      IVORA_TENANT_ID: "",
      OPERATOR_PASSWORD: "",
      QR_BASE_URL: "",
    },
  },
});
