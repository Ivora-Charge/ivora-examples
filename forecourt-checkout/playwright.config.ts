import { defineConfig, devices } from "@playwright/test";

// Runs the demo end to end against `next dev` with no credentials: no network
// calls leave the machine.
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  use: {
    baseURL: "http://localhost:3110",
    trace: "retain-on-failure",
  },
  projects: [{ name: "mobile", use: { ...devices["Pixel 7"] } }],
  webServer: {
    command: "npm run dev -- --port 3110",
    url: "http://localhost:3110",
    env: { DEMO_MODE: "1" },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
