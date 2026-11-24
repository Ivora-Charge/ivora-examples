import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { E2E_ADMIN_SECRET, SETUPS, type Setup } from "../playwright.config";
import { goTo } from "./support";

/**
 * What a visitor who is not signed in is sent. The rule: the sign-in prompt, and
 * nothing about this deployment's configuration.
 *
 * It is tested without knowing what a leak would look like. The same build runs under
 * five configurations (playwright.config.ts). Every page of the app is fetched from
 * each, as HTML with its inline page data and as the page data a client navigation
 * fetches, and the answers must be the same, byte for byte. A page that hands a
 * visitor anything read from the configuration (a value, an address, "is it set")
 * differs between two of them and fails, whatever the thing is called.
 *
 * The documented differences, and the only ones allowed:
 * - The mode, which `GET /api/v1/status` answers to anyone. Demo mode shows its banner
 *   on every page and tells the pages `demo`; two pages then carry constants of the
 *   built-in sample data (its days, its driver). So the comparison is within a mode:
 *   three demo setups (defaults; unset and malformed; everything set and well formed)
 *   and two live ones that differ in every setting. Across the modes, the page as
 *   shown, less the banner, must still be the same.
 * - On the sign-in page only, whether the admin secret is offered (`secretEnabled`).
 */

/** Every page of the app, found on disk: a new page is covered without listing it. */
function routes(dir = join(__dirname, "../app"), at = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory())
      return routes(
        join(dir, entry.name),
        // A dynamic segment gets an ID that names nothing.
        `${at}/${entry.name.startsWith("[") ? "00000000-0000-4000-8000-000000000000" : entry.name}`,
      );
    return entry.name === "page.tsx" ? [at || "/"] : [];
  });
}
const SIGN_IN = "/admin/sign-in";
const ROUTES = [
  ...routes().sort(),
  // A query the page reads.
  "/admin/payments?find=22222222-2222-4222-8222-222222222222",
];

type Wire = { html: string; data: string };

async function fetchAll(
  request: APIRequestContext,
  setup: Setup,
): Promise<Map<string, Wire>> {
  const out = new Map<string, Wire>();
  for (const path of ROUTES) {
    const what = `${setup.name} ${path}`;
    const html = await request.get(`${setup.url}${path}`);
    expect(html.ok(), what).toBe(true);
    const data = await request.get(`${setup.url}${path}`, {
      headers: { RSC: "1" },
    });
    expect(data.ok(), what).toBe(true);
    expect(data.headers()["content-type"], what).toContain("text/x-component");
    out.set(path, {
      html: await html.text(),
      data: sameRequest(await data.text()),
    });
  }
  return out;
}

// The HTML carries the page data inside a script string, with its quotes escaped.
const plain = (body: string) => body.replaceAll("\\", "");

/**
 * The page data as sent, less the one thing the framework makes up per request: the
 * random key it gives the two metadata boundaries of a client navigation's answer.
 * Two answers of one server differ by it too.
 */
const sameRequest = (data: string) =>
  data.replaceAll(
    /(\["\$","\$L[0-9a-f]+",)"[\w-]{21}[a-z]"(?=,\{"children")/g,
    '$1"REQUEST"',
  );

/** The page as shown before any script runs, less the demo banner. */
const shown = (html: string) =>
  html
    .replaceAll(/<script\b.*?<\/script>/gs, "")
    .replace(/<p class="demo-banner".*?<\/p>/s, "");

// Any environment variable's name, and what configErrors() says about one.
const VARIABLE = /\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/g;
const ERROR_TEXT =
  /must be|is not set|sk_ or rk_|whsec_|\(re_\)|CURRENCY:minor|Malformed/;
// Whether something is set, under the names the pages use for it.
const PRESENCE =
  /secretEnabled|adminEnabled|stripeKey|stripeSet":(true|false)|webhookSecret|cronSecret|"missing"|"errors"|"malformed"|"settings":\{/;

function expectNoHints(raw: string, what: string, setup: Setup) {
  const body = plain(raw);
  expect(
    // NEXT_REDIRECT is the framework's word in a redirect's page data.
    (body.match(VARIABLE) ?? []).filter((name) => name !== "NEXT_REDIRECT"),
    `${what}: variable names`,
  ).toEqual([]);
  expect(body, `${what}: config error text`).not.toMatch(ERROR_TEXT);
  expect(body, `${what}: presence flags`).not.toMatch(PRESENCE);
  // No value of its configuration either, whole or (for an address) by its host.
  for (const [name, value] of Object.entries(setup.env)) {
    if (value.length < 3 || value === "bad" || value === "true") continue;
    const part = value.startsWith("https://") ? new URL(value).host : value;
    expect(body.includes(part), `${what}: the value of ${name}`).toBe(false);
  }
  expect(body, `${what}: our address`).not.toMatch(
    /localhost|ocpi\/versions"|ocpi\/2\.2\.1/,
  );
}

test("every signed-out page is the same whatever the deployment's configuration", async ({
  request,
}) => {
  test.setTimeout(180_000);
  // The app has the pages this test thinks it has.
  expect(ROUTES).toEqual(
    expect.arrayContaining([
      "/",
      "/admin/payments",
      "/admin/peers",
      "/admin/peers/connect",
      "/admin/tokens",
      SIGN_IN,
    ]),
  );

  // The setups are what they claim to be, by the public status API.
  const sent = new Map<string, Map<string, Wire>>();
  for (const setup of SETUPS) {
    const status = await request.get(`${setup.url}/api/v1/status`);
    expect((await status.json()).mode, setup.name).toBe(setup.mode);
    sent.set(setup.name, await fetchAll(request, setup));
  }

  // Within a mode, every setup sends what the first one does: nothing taken out.
  for (const mode of ["demo", "live"] as const) {
    const [first, ...others] = SETUPS.filter((s) => s.mode === mode);
    expect(others.length, mode).toBeGreaterThan(0);
    for (const other of others)
      for (const path of ROUTES) {
        // Whether the admin secret is offered is the sign-in page's to say.
        if (path === SIGN_IN && other.secret !== first.secret) continue;
        const what = `${path}: ${first.name} and ${other.name}`;
        const a = sent.get(first.name)!.get(path)!;
        const b = sent.get(other.name)!.get(path)!;
        expect(b.html, `${what} (HTML)`).toBe(a.html);
        expect(b.data, `${what} (page data)`).toBe(a.data);
      }
  }

  // And by name: what a setting, an error or a flag would look like if it were sent.
  for (const setup of SETUPS)
    for (const path of ROUTES) {
      const what = `${setup.name} ${path}`;
      const { html, data } = sent.get(setup.name)!.get(path)!;
      // The inline page data is in the HTML too.
      expect(html, what).toContain("__next_f");
      if (path === SIGN_IN) continue;
      expect(html, what).toContain("Sign in as an admin");
      expectNoHints(html, `${what} (HTML)`, setup);
      expectNoHints(data, `${what} (page data)`, setup);
    }

  // Across the modes, a visitor is shown the same page but for the banner.
  const demo = sent.get("demo")!;
  const live = sent.get("live-a")!;
  for (const path of ROUTES) {
    // The sign-in page words its admin-secret step for a demo.
    if (path === SIGN_IN) continue;
    expect(demo.get(path)!.html, path).toContain('class="demo-banner"');
    expect(live.get(path)!.html, path).not.toContain("demo-banner");
    expect(
      shown(live.get(path)!.html),
      `${path}: demo and live, as shown`,
    ).toBe(shown(demo.get(path)!.html));
  }
});

test("only the sign-in page is told whether the admin secret is set, and nothing else", async ({
  request,
}) => {
  const bodies: string[] = [];
  for (const setup of SETUPS)
    for (const headers of [{}, { RSC: "1" }] as Record<string, string>[]) {
      const res = await request.get(`${setup.url}${SIGN_IN}`, { headers });
      const body = plain(await res.text());
      const what = `${setup.name} sign-in`;
      expect(body, what).toContain(`"secretEnabled":${setup.secret}`);
      expect(body.match(VARIABLE) ?? [], what).toEqual([]);
      expect(body, what).not.toMatch(ERROR_TEXT);
      expect(body, what).not.toMatch(
        /stripeKey|stripeSet|webhookSecret|cronSecret|"missing"/,
      );
      if (setup.mode === "live" && !("RSC" in headers)) bodies.push(body);
    }
  // The two live setups differ on this page by that flag and what it shows, only.
  expect(bodies.length).toBe(2);
  expect(bodies[0]).not.toBe(bodies[1]);
});

test("with the admin secret, the pages say how to find what the server did not send", async ({
  page,
}) => {
  // The admin secret lives in the page's memory, which the server cannot see when it
  // renders: the settings are not read, and the pages say how to check by hand.
  const wrong = SETUPS.find((s) => s.name === "misconfigured")!;
  await page.goto(`${wrong.url}${SIGN_IN}`);
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
  // Nor our OCPI party: the page names the public API that answers it.
  const about = page.getByRole("complementary", {
    name: "About this deployment",
  });
  await expect(about).toContainText("GET /api/v1/status");
  await expect(about).not.toContainText("ZZ-DMO");

  await goTo(page, "Peers");
  const ours = page.getByLabel("Our versions URL");
  await expect(ours).toContainText("/ocpi/versions");
  await expect(ours).toContainText("only to an admin signed in by email");
  await expect(ours).not.toContainText("localhost");
  await expect(page.getByRole("main")).not.toContainText("ZZ-DMO");
});
