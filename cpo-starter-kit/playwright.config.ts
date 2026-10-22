import { defineConfig, devices } from "@playwright/test";

const PORT = 3307;
const PORT_FLEET_OFF = 3308;

const demoEnv = {
  DEMO_MODE: "true",
  IVORA_API_KEY: "",
  IVORA_TENANT_ID: "",
};

// Runs the built app in demo mode: no credentials, no network beyond localhost. Two
// servers: one with the optional Cards module (FLEET_MODULE) on, where every spec
// runs, and one with it off, where the end-to-end journey runs again and
// fleet-off.spec.ts checks that Cards is gone. Each on desktop and on a phone.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  projects: [
    {
      name: "desktop",
      testIgnore: "fleet-off.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://localhost:${PORT}`,
      },
      metadata: { fleet: true },
    },
    {
      name: "mobile",
      testIgnore: "fleet-off.spec.ts",
      use: { ...devices["Pixel 7"], baseURL: `http://localhost:${PORT}` },
      metadata: { fleet: true },
    },
    {
      name: "desktop-fleet-off",
      testMatch: ["journey.spec.ts", "fleet-off.spec.ts"],
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://localhost:${PORT_FLEET_OFF}`,
      },
      metadata: { fleet: false },
    },
    {
      name: "mobile-fleet-off",
      testMatch: ["journey.spec.ts", "fleet-off.spec.ts"],
      use: {
        ...devices["Pixel 7"],
        baseURL: `http://localhost:${PORT_FLEET_OFF}`,
      },
      metadata: { fleet: false },
    },
  ],
  webServer: [
    {
      command: `npx next start -p ${PORT}`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: false,
      env: { ...demoEnv, FLEET_MODULE: "1" },
    },
    {
      command: `npx next start -p ${PORT_FLEET_OFF}`,
      url: `http://localhost:${PORT_FLEET_OFF}`,
      reuseExistingServer: false,
      env: { ...demoEnv, FLEET_MODULE: "" },
    },
  ],
});
