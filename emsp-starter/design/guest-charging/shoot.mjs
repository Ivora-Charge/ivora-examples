// Takes the screenshots in screens/: node shoot.mjs (after `npm ci` in ../../server,
// whose Playwright it borrows). Reads the built HTML files from disk; no server, no network.
//   node shoot.mjs              every picture the README embeds
//   node shoot.mjs session      only the ones whose name starts with that
// The pictures are then reduced to 256 colours to keep them small (see the README).
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(
  new URL("../../server/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");

const ALL = ["light", "dark"];
/**
 * Screen file, state, and the themes of its phone and desktop pictures: exactly the
 * pictures the README embeds. The main path is shown in all four; the other states once
 * per size. Any other PNG in screens/ is removed.
 */
const SHOTS = [
  // The main path.
  ["start", "ready", ALL, ALL],
  ["status", "waiting", ALL, ALL],
  ["status", "starting", ALL, ALL],
  ["session", "charging", ALL, ALL],
  ["session", "keep", ALL, ALL],
  ["receipt", "paid", ALL, ALL],
  ["charging", "open", ALL, ALL],
  // The other states.
  ["start", "charger", ["light"], ["dark"]],
  ["start", "noprice", ["dark"], ["light"]],
  ["start", "paused", ["light"], ["dark"]],
  ["start", "open", ["dark"], ["light"]],
  ["card", "page", ["light"], ["dark"]],
  ["card", "declined", ["dark"], ["light"]],
  ["card", "bank", ["light"], ["dark"]],
  ["card", "sheet", ["light", "dark"], []],
  ["status", "confirming", ["dark"], ["light"]],
  ["status", "declined", ["light"], ["dark"]],
  ["status", "expired", ["dark"], ["light"]],
  ["status", "plugin", ["light"], ["dark"]],
  ["status", "refused", ["dark"], ["light"]],
  ["status", "noanswer", ["light"], ["dark"]],
  ["session", "capped", ["dark"], ["light"]],
  ["session", "linked", ["light"], ["dark"]],
  ["receipt", "above", ["dark"], ["light"]],
  ["receipt", "lost", ["light"], ["dark"]],
  ["charging", "resume", ["dark"], ["light"]],
  ["account", "nocard", ["light"], ["dark"]],
];
const SIZES = {
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1.5,
    isMobile: true,
    hasTouch: true,
  },
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
};

const only = process.argv[2] ?? "";
const out = new URL("screens/", import.meta.url);
mkdirSync(out, { recursive: true });
const wanted = new Set();
const browser = await chromium.launch();
let n = 0;
for (const [size, options] of Object.entries(SIZES))
  for (const scheme of ALL) {
    const context = await browser.newContext({
      ...options,
      colorScheme: scheme,
      offline: true,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    for (const [file, state, phone, desktop] of SHOTS) {
      if (!(size === "phone" ? phone : desktop).includes(scheme)) continue;
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
