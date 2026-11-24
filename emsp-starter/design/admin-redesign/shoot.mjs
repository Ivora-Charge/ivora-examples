// Takes the screenshots in screens/: node shoot.mjs (after `npm ci` in ../../server,
// whose Playwright it borrows). Reads the built HTML files from disk; no server, no network.
//   node shoot.mjs            every picture the README embeds
//   node shoot.mjs setup-mid  only the ones whose name starts with that
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(
  new URL("../../server/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");

/**
 * Screen file, state, and the theme of its phone and its desktop picture: exactly the
 * pictures the README embeds. Any other PNG in screens/ is removed.
 */
const SHOTS = [
  ["setup", "env", "light", "dark"],
  ["setup", "blank", "dark", "light"],
  ["setup", "webhook", "light", "dark"],
  ["setup", "mid", "light", "dark"],
  ["setup", "peer", "dark", "light"],
  ["setup", "health", "light", null],
  ["setup", "late", null, "light"],
  ["sign-in", "code", "light", "dark"],
  ["sign-in", "limit", "dark", "light"],
  ["sign-in", "first", "light", "dark"],
  ["peers", "out", "light", "dark"],
  ["peers", "list", "dark", "light"],
  ["connect", "hub-form", "light", "dark"],
  ["connect", "hub-done", "dark", "light"],
  ["connect", "hub-refused", "light", "dark"],
  ["hub", "trusted", "light", "dark"],
  ["sessions", "list", "dark", "light"],
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
const wanted = new Set();
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
    for (const [file, state, phone, desktop] of SHOTS) {
      if ((size === "phone" ? phone : desktop) !== scheme) continue;
      const name = `${file}-${state}-${size}-${scheme}`;
      wanted.add(`${name}.png`);
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
let removed = 0;
for (const f of readdirSync(out))
  if (f.endsWith(".png") && !wanted.has(f)) {
    rmSync(new URL(f, out));
    removed += 1;
  }
console.log(`${n} screenshots in screens/, ${removed} stray removed`);
