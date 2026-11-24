// Takes the screenshots in screens/: node shoot.mjs (after `npm ci` in ../../server,
// whose Playwright it borrows). Reads the built HTML files from disk; no server, no network.
//   node shoot.mjs            every picture
//   node shoot.mjs setup-mid  only the ones whose name starts with that
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(
  new URL("../../server/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");

/** Screen file and state: the ones the brief names, at both widths, light and dark. */
const SHOTS = [
  ["setup", "mid"],
  ["setup", "blank"],
  ["setup", "health"],
  ["setup", "late"],
  ["sign-in", "code"],
  ["sign-in", "limit"],
  ["sign-in", "limit-mail"],
  ["sign-in", "first"],
  ["peers", "out"],
  ["peers", "list"],
  ["connect", "hub-form"],
  ["connect", "hub-done"],
  ["connect", "hub-refused"],
  ["hub", "trusted"],
  ["sessions", "list"],
];
const SIZES = {
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
};

const only = process.argv[2] ?? "";
const out = new URL("screens/", import.meta.url);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
let n = 0;
for (const [size, options] of Object.entries(SIZES))
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({
      ...options,
      colorScheme: scheme,
      offline: true,
    });
    const page = await context.newPage();
    for (const [file, state] of SHOTS) {
      const name = `${file}-${state}-${size}-${scheme}`;
      if (!name.startsWith(only)) continue;
      const url = new URL(`${file}.html?shot=1#${state}`, import.meta.url);
      await page.goto(url.href);
      await page.reload(); // a hash-only change does not reload: start each state clean
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: fileURLToPath(new URL(`${name}.png`, out)),
        fullPage: true,
      });
      n += 1;
    }
    await context.close();
  }
await browser.close();
console.log(`${n} screenshots in screens/`);
