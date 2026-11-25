// Checks the built mockups in a real browser, offline: node check.mjs (after `npm ci`
// in ../../server, whose Playwright and axe it borrows). Every state of every screen, on
// a phone (390) and at 1280, light and dark. It fails when:
//   - axe finds a WCAG 2.1 A or AA violation (contrast included);
//   - a state does not show exactly one h1;
//   - a button or field is shorter than 44px;
//   - a state is wider than its window;
//   - a link leaves the folder, or points at a screen or state that does not exist;
//   - a button that names a state does not lead there;
//   - a screen asks the network for anything, or throws.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../server/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const { default: AxeBuilder } = require("@axe-core/playwright");
const { screens } = await import("./src/screens.mjs");

const here = (p) => new URL(p, import.meta.url);
const problems = new Set();
const fail = (where, what) => problems.add(`${where}: ${what}`);
const statesOf = Object.fromEntries(
  screens.map((s) => [s.file, s.states.map(([id]) => id)]),
);
statesOf.index = ["default"];

// Links: relative, inside this folder, to a screen and a state that exist.
for (const file of Object.keys(statesOf)) {
  const html = readFileSync(here(`${file}.html`), "utf8");
  for (const [, href] of html.matchAll(/<a\s[^>]*?href="([^"]*)"/g)) {
    if (href === "#") continue; // a place the mockup does not cover, marked disabled
    const [path, hash = ""] = href.split("#");
    const target = path === "" ? file : path.replace(/\.html$/, "");
    if (/^([a-z]+:|\/)/i.test(href) || path.includes("/"))
      fail(file, `link is not relative to this folder: ${href}`);
    else if (!existsSync(here(`${target}.html`)) || !(target in statesOf))
      fail(file, `link to a screen that does not exist: ${href}`);
    else if (hash && !statesOf[target].includes(hash))
      fail(file, `link to a state that does not exist: ${href}`);
  }
}

const SIZES = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true },
  desktop: { viewport: { width: 1280, height: 800 } },
};

const browser = await chromium.launch();
let views = 0;
let controls = 0;
for (const [size, options] of Object.entries(SIZES))
  for (const colorScheme of ["light", "dark"]) {
    const context = await browser.newContext({
      ...options,
      colorScheme,
      offline: true,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    let where = "";
    page.on("pageerror", (e) => fail(where, `page error: ${e.message}`));
    page.on("request", (r) => {
      if (!r.url().startsWith("file:") && !r.url().startsWith("data:"))
        fail(where, `network request: ${r.url()}`);
    });
    for (const [file, states] of Object.entries(statesOf))
      for (const state of states) {
        const open = async () => {
          await page.goto(here(`${file}.html?shot=1#${state}`).href);
          await page.reload(); // a hash-only change does not reload: start clean
        };
        where = `${file}#${state} (${size}, ${colorScheme})`;
        await open();
        views += 1;

        const found = await page.evaluate(() => {
          const shown = (el) => el.checkVisibility();
          const wide =
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth;
          const h1 = [...document.querySelectorAll("h1")].filter(shown).length;
          const short = [
            ...document.querySelectorAll(
              "main button, main input, main a.btn, main a.row-link, main a.s-pay, main a.back, .tabs a, .rail a",
            ),
          ]
            .filter((el) => shown(el) && !el.closest("[inert]"))
            .filter((el) => el.getBoundingClientRect().height < 43.5)
            .map(
              (el) =>
                `${el.tagName.toLowerCase()} "${(el.textContent || el.id).trim().slice(0, 30)}"`,
            );
          return { wide, h1, short };
        });
        if (found.wide > 0)
          fail(where, `${found.wide}px wider than the window`);
        if (found.h1 !== 1) fail(where, `${found.h1} visible h1`);
        for (const s of found.short) fail(where, `shorter than 44px: ${s}`);

        const axe = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        for (const v of axe.violations)
          fail(
            where,
            `axe ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
          );

        const count = await page
          .locator("main button[data-go]:visible")
          .count();
        for (let i = 0; i < count; i += 1) {
          await open();
          const el = page.locator("main button[data-go]:visible").nth(i);
          const to = await el.getAttribute("data-go");
          await el.click();
          await page.waitForTimeout(30);
          const got = await page.evaluate(() => document.body.dataset.state);
          if (got !== to) fail(where, `"${to}" button led to "${got}"`);
          controls += 1;
        }
      }
    await context.close();
  }
await browser.close();

if (problems.size) {
  console.error([...problems].join("\n"));
  console.error(`\n${problems.size} problem(s)`);
  process.exit(1);
}
console.log(
  `ok: ${views} views (${Object.values(statesOf).flat().length} states, phone and 1280, light and dark): no axe violation, one h1, 44px controls, fits the window, links relative, no network; ${controls} state buttons led where they say`,
);
