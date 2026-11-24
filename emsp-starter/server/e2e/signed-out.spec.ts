import { expect, test } from "@playwright/test";
import {
  E2E_ADMIN_SECRET,
  MISCONFIGURED_ENV,
  MISCONFIGURED_URL,
} from "../playwright.config";
import { goTo } from "./support";

/**
 * What a visitor who is not signed in is sent, by a deployment whose settings are
 * wrong (playwright.config.ts: every live-mode setting unset, optional ones
 * malformed, ADMIN_SECRET set). Read from the wire, not from the visible page: the
 * HTML with its inline page data, and the page data a client navigation fetches.
 */
const PAGES = [
  "/",
  "/admin/peers",
  "/admin/peers/connect",
  "/admin/sessions",
  "/admin/problems",
  "/admin/payments",
  "/admin/reconciliation",
  "/admin/tokens",
];

// Any environment variable's name, and the ones this server has something to say about.
const VARIABLE = /\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/g;
const NAMES = [...Object.keys(MISCONFIGURED_ENV), "ADMIN_SECRET", "DEMO_MODE"];
// The sentences of configErrors(), and "is not set" of the page.
const ERROR_TEXT =
  /must be|is not set|sk_ or rk_|whsec_|\(re_\)|CURRENCY:minor|Malformed/;
// Whether a secret is set: the admin secret, or the payment and job ones.
const PRESENCE =
  /secretEnabled|adminEnabled|stripeKey|webhookSecret|cronSecret|"missing"|"errors"|"malformed"|"settings":\{/;

// The HTML carries the page data inside a script string, with its quotes escaped.
const plain = (body: string) => body.replaceAll("\\", "");

function expectNoHints(raw: string, what: string) {
  const body = plain(raw);
  expect(body.match(VARIABLE) ?? [], `${what}: variable names`).toEqual([]);
  for (const name of NAMES) expect(body, what).not.toContain(name);
  expect(body, `${what}: config error text`).not.toMatch(ERROR_TEXT);
  expect(body, `${what}: presence flags`).not.toMatch(PRESENCE);
}

test("a wrongly set up deployment tells a visitor nothing about its settings", async ({
  request,
}) => {
  // It is in demo mode because of its settings, which the public status API says.
  const status = await request.get(`${MISCONFIGURED_URL}/api/v1/status`);
  expect((await status.json()).mode).toBe("demo");

  for (const path of PAGES) {
    const html = await request.get(`${MISCONFIGURED_URL}${path}`);
    expect(html.ok(), path).toBe(true);
    const body = await html.text();
    expect(body, path).toContain("Sign in as an admin");
    // The inline page data is in the HTML too.
    expect(body, path).toContain("__next_f");
    expectNoHints(body, `${path} (HTML)`);

    const rsc = await request.get(`${MISCONFIGURED_URL}${path}`, {
      headers: { RSC: "1" },
    });
    expect(rsc.ok(), path).toBe(true);
    expect(rsc.headers()["content-type"], path).toContain("text/x-component");
    expectNoHints(await rsc.text(), `${path} (page data)`);
  }
});

test("only the sign-in page is told that the admin secret is set", async ({
  request,
}) => {
  const both: Record<string, string>[] = [{}, { RSC: "1" }];
  for (const headers of both) {
    const res = await request.get(`${MISCONFIGURED_URL}/admin/sign-in`, {
      headers,
    });
    const body = plain(await res.text());
    // It offers the secret, and that is all it says about the settings.
    expect(body).toContain('"secretEnabled":true');
    // The same check that finds nothing on the other pages finds this one.
    expect(body).toMatch(PRESENCE);
    expect(body.match(VARIABLE) ?? []).toEqual([]);
    expect(body).not.toMatch(ERROR_TEXT);
    expect(body).not.toMatch(/stripeKey|webhookSecret|cronSecret|"missing"/);
  }
});

test("with the admin secret, stop 1 cannot check and names no setting", async ({
  page,
}) => {
  // The admin secret lives in the page's memory, which the server cannot see when it
  // renders: the settings are not read, and the stop says how to check by hand.
  await page.goto(`${MISCONFIGURED_URL}/admin/sign-in`);
  await page
    .getByRole("button", { name: "Use the admin secret instead" })
    .click();
  await page.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Account", level: 1 }),
  ).toBeVisible();
  await goTo(page, "Setup");
  const stop = page.locator("#stop-1");
  await expect(stop).toContainText("Cannot check from here");
  await expect(stop).toContainText("only to an admin signed in by email");
  const main = page.getByRole("main");
  await expect(main).not.toContainText(/is not set\.|Malformed|must be/);
  for (const name of ["PUBLIC_BASE_URL", "HOLD_AMOUNTS", "RESEND_API_KEY"])
    await expect(main).not.toContainText(name);
});
