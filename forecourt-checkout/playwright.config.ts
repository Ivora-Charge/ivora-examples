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
  projects: [
    // Pay at the charger: the driver's phone.
    {
      name: "mobile",
      testMatch: "demo.spec.ts",
      use: { ...devices["Pixel 7"] },
    },
    // Pay in store: the cashier console on a desktop and a tablet.
    {
      name: "desktop",
      testMatch: "store.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "tablet",
      testMatch: "store.spec.ts",
      use: { ...devices["Galaxy Tab S9 landscape"] },
    },
  ],
  webServer: {
    command: "npm run dev -- --port 3110",
    url: "http://localhost:3110",
    env: { DEMO_MODE: "1" },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
