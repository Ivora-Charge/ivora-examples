// Checks the built mockups in a real browser, offline: node check.mjs (after `npm ci`
// in ../../server, whose Playwright it borrows). It fails when:
//   - focusing, clicking or typing in a form field changes the state of a screen
//     (only buttons and links may do that);
//   - a submit button or a state link does not lead where it says;
//   - a link leaves the folder, or points at a screen or state that does not exist;
//   - a screen asks the network for anything, or throws;
//   - a screen is wider than a phone, or a copy box cuts off its text.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../server/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const { screens } = await import("./src/screens.mjs");

const here = (p) => new URL(p, import.meta.url);
const problems = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);
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
    else if (hash && hash !== "main" && !statesOf[target].includes(hash))
      fail(file, `link to a state that does not exist: ${href}`);
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  offline: true,
});
const page = await context.newPage();
let where = "";
page.on("pageerror", (e) => fail(where, `page error: ${e.message}`));
page.on("request", (r) => {
  if (!r.url().startsWith("file:") && !r.url().startsWith("data:"))
    fail(where, `network request: ${r.url()}`);
});
const stateNow = () =>
  page.evaluate(() => `${document.body.dataset.state}${location.hash}`);
const open = async (file, state) => {
  where = `${file}#${state}`;
  await page.goto(here(`${file}.html?shot=1#${state}`).href);
  await page.reload(); // a hash-only change does not reload: start each state clean
};

let fields = 0;
let submits = 0;
let gos = 0;
for (const [file, states] of Object.entries(statesOf))
  for (const state of states) {
    await open(file, state);

    // Fits a phone, and no copy box hides text.
    const wide = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    if (wide > 0) fail(where, `${wide}px wider than the phone`);
    const cut = await page.evaluate(
      () =>
        [...document.querySelectorAll(".copy pre, .copy .v")].filter(
          (el) => el.offsetParent && el.scrollWidth > el.clientWidth + 1,
        ).length,
    );
    if (cut) fail(where, `${cut} copy box(es) cut off their text`);

    // A field never changes the state: tap it, focus it, type in it.
    const inputs = page.locator(
      "input:visible, textarea:visible, select:visible",
    );
    const total = await inputs.count();
    for (let i = 0; i < total; i += 1) {
      const before = await stateNow();
      const el = () => inputs.nth(i);
      const name = (await el().getAttribute("id")) ?? `field ${i}`;
      const type = await el().getAttribute("type");
      const acts = [
        ["a tap", () => el().tap()],
        ["a click", () => el().click()],
        ["focus", () => el().focus()],
        ["typing", () => el().pressSequentially(type === "search" ? "" : "1")],
      ];
      for (const [what, act] of acts) {
        await act();
        await page.waitForTimeout(50);
        const after = await stateNow();
        if (after === before) continue;
        fail(where, `${what} in field "${name}" changed the state to ${after}`);
        await open(file, state);
      }
      fields += 1;
    }

    // A form's submit button leads where the form says.
    const forms = page.locator("form[data-submit-go]:visible");
    for (let i = 0; i < (await forms.count()); i += 1) {
      await open(file, state);
      const form = page.locator("form[data-submit-go]:visible").nth(i);
      const to = await form.getAttribute("data-submit-go");
      await form.evaluate((f) => f.setAttribute("novalidate", ""));
      await form.locator('button[type="submit"]').click();
      await page.waitForTimeout(50);
      const got = await page.evaluate(() => document.body.dataset.state);
      if (got !== to) fail(where, `submit led to "${got}", not "${to}"`);
      submits += 1;
    }

    // So does every button or link that names a state.
    await open(file, state);
    const count = await page.locator("[data-go]:visible").count();
    for (let i = 0; i < count; i += 1) {
      await open(file, state);
      const el = page.locator("[data-go]:visible").nth(i);
      const to = await el.getAttribute("data-go");
      await el.click();
      await page.waitForTimeout(50);
      const got = await page.evaluate(() => document.body.dataset.state);
      if (got !== to) fail(where, `"${to}" control led to "${got}"`);
      gos += 1;
    }
  }
await browser.close();

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}
const n = Object.values(statesOf).flat().length;
console.log(
  `ok: ${n} states, ${fields} fields left the state alone, ${submits} submits and ${gos} state controls led where they say; links relative, no network, fits 390px`,
);
