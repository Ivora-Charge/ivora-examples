import { defineConfig, devices } from "@playwright/test";

const PORT = 8091;

// Serves the web build from `npm run build` (dist/). Built without EXPO_PUBLIC_API_URL,
// it runs the offline demo: no network beyond localhost (the tests block map tiles).
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    // WebGL for the map in headless Chromium, drawn in software.
    launchOptions: { args: ["--enable-unsafe-swiftshader"] },
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    // 390 px wide, the narrowest phone the layout is checked at.
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: `npx expo serve --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
  },
});
