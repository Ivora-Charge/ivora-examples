import { defineConfig, devices } from "@playwright/test";

const PORT = 8091;

// Serves the web build from `npm run build` (dist/). Built without EXPO_PUBLIC_API_URL,
// it runs the offline demo: no network beyond localhost.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npx expo serve --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
  },
});
