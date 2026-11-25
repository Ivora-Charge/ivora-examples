import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { SETUPS } from "./playwright.config";

/**
 * The one-domain build: the driver app at / and the admin at /admin, on one origin
 * (README: One domain). Build it first, with the app's API on the first server here:
 *
 *   EXPO_PUBLIC_API_URL=http://localhost:3330 npm run build:one-domain
 *   npm run test:e2e:one-domain
 *
 * Like playwright.config.ts it runs offline, on made-up settings (see there).
 */
const PORT = 3330;
const server = (name: string, port: number) => {
  const setup = SETUPS.find((s) => s.name === name)!;
  return { ...setup, url: `http://localhost:${port}` };
};
/** Demo mode, the app's server; and a live setup whose database has an admin. */
export const DEMO = server("demo", PORT);
export const WITH_ADMIN = server("live-admin", PORT + 1);

const index = join(__dirname, "public/index.html");
if (
  !existsSync(join(__dirname, ".driver-web.json")) ||
  !readFileSync(index, "utf8").includes(` ${DEMO.url} `)
)
  throw new Error(
    `These tests need the one-domain build, with the app's API here: EXPO_PUBLIC_API_URL=${DEMO.url} npm run build:one-domain`,
  );

export default defineConfig({
  testDir: ".",
  // The malformed-OCPI-path tests are the ones the server-only build passes.
  testMatch: ["e2e-one-domain/*.spec.ts", "e2e/ocpi-paths.spec.ts"],
  timeout: 60_000,
  use: {
    baseURL: DEMO.url,
    // WebGL for the app's map in headless Chromium, drawn in software.
    launchOptions: { args: ["--enable-unsafe-swiftshader"] },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [DEMO, WITH_ADMIN].map((setup) => ({
    command: `npx next start -p ${new URL(setup.url).port}`,
    url: `${setup.url}/api/v1/status`,
    reuseExistingServer: false,
    env: setup.env,
  })),
});
