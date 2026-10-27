// Regenerates docs/screens/ from the demo: the main screens at desktop (1440 px) and
// phone (390 px), in light and dark. Start the demo first, then run this:
//
//   DEMO_MODE=true FLEET_MODULE=1 npm run build && DEMO_MODE=true FLEET_MODULE=1 npm start
//   npm run screenshots            (SCREENSHOT_URL=http://localhost:3000 by default)
//
// It fails if a page does not load or scrolls sideways.
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const base = process.env.SCREENSHOT_URL ?? "http://localhost:3000";
const out = new URL("../docs/screens/", import.meta.url).pathname;
const SCREENS = {
  welcome: "/welcome",
  overview: "/",
  onboarding: "/onboarding",
  chargers: "/chargers",
  charger: "/chargers/station-9101",
  live: "/live",
  pricing: "/pricing",
  tariff: "/pricing/demo-standard",
  "tariff-cad": "/pricing/demo-standard-cad",
  reports: "/reports",
  cards: "/cards",
  team: "/team",
  roaming: "/settings/roaming",
  // The driver's sticker page (codes are made on the charger page first).
  driver: null,
};
const SIZES = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
};

/** The sticker page of the first demo connector. */
async function stickerPath(page) {
  await page.goto(`${base}/chargers/station-9101`);
  const make = page.getByRole("button", { name: "Create sticker codes" });
  if (await make.count()) await make.click();
  const url = await page.locator(".sticker-url").first().textContent();
  return new URL(url).pathname;
}

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
      const res = await page.goto(base + (path ?? (await stickerPath(page))), {
        waitUntil: "networkidle",
      });
      if (!res?.ok()) throw new Error(`${name}: HTTP ${res?.status()}`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      if (overflow > 0) throw new Error(`${name} scrolls sideways (${size})`);
      await page.screenshot({ path: `${out}${name}-${size}-${scheme}.png` });
    }
    await context.close();
  }
await browser.close();
