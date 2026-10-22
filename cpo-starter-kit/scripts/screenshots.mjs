// Regenerates docs/screens/ from the demo: the main screens at desktop (1440 px) and
// phone (390 px), in light and dark. Start the demo first, then run this:
//
//   DEMO_MODE=true FLEET_MODULE=1 npm run build && DEMO_MODE=true FLEET_MODULE=1 npm start
//   npm run screenshots            (SCREENSHOT_URL=http://localhost:3000 by default)
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const base = process.env.SCREENSHOT_URL ?? "http://localhost:3000";
const out = new URL("../docs/screens/", import.meta.url).pathname;
const SCREENS = {
  welcome: "/welcome",
  overview: "/",
  onboarding: "/onboarding",
  chargers: "/chargers",
  live: "/live",
  pricing: "/pricing",
  reports: "/reports",
  team: "/team",
  cards: "/cards",
  roaming: "/settings/roaming",
};
const SIZES = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
};

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
for (const [size, viewport] of Object.entries(SIZES))
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport,
      colorScheme: scheme,
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    for (const [name, path] of Object.entries(SCREENS)) {
      const res = await page.goto(base + path, { waitUntil: "networkidle" });
      if (!res?.ok()) {
        console.warn(`skip ${name}: ${res?.status()}`);
        continue;
      }
      await page.screenshot({ path: `${out}${name}-${size}-${scheme}.png` });
    }
    await context.close();
  }
await browser.close();
