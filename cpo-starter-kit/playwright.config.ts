import { defineConfig, devices } from "@playwright/test";

const PORT = 3307;

// Runs the built app in demo mode: no credentials, no network beyond localhost.
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
    env: {
      DEMO_MODE: "true",
      IVORA_API_KEY: "",
      IVORA_TENANT_ID: "",
    },
  },
});
