import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { E2E_ADMIN_SECRET, SETUPS, type Setup } from "../playwright.config";
import { expectAccessible, goTo } from "./support";

/**
 * What a visitor who is not signed in is sent. The rule: the sign-in prompt, and
 * nothing about this deployment's configuration.
 *
 * It is tested without knowing what a leak would look like. The same build runs under
 * six configurations (playwright.config.ts). Every page of the app is fetched from
 * each, as HTML with its inline page data and as the page data a client navigation
 * fetches, and the answers must be the same: every byte of one is in the other. A page
 * that hands a visitor anything read from the configuration (a value, an address, "is
 * it set") differs between two of them and fails, whatever the thing is called.
 *
 * Only the order of the stream is not compared. The framework sends the page data in
 * rows as they become ready and cuts the HTML's copy of it into scripts where it
 * likes, so two answers of one server can differ in that. The comparison is of the
 * page as rendered (the HTML with those scripts taken out, byte for byte) and of the
 * page data decoded into its rows, whatever order they came in (`rendered`, `rows`).
 *
 * The documented differences, and the only ones allowed:
 * - The mode, which `GET /api/v1/status` answers to anyone. Demo mode shows its banner
 *   on every page and tells the pages `demo`; two pages then carry constants of the
 *   built-in sample data (its days, its driver). So the comparison is within a mode:
 *   three demo setups (defaults; unset and malformed; everything set and well formed)
 *   and two live ones that differ in every setting. Across the modes, the page as
 *   shown, less the banner, must still be the same.
 * - On the sign-in page only, whether the admin secret is offered (`secretEnabled`);
 *   in demo mode without it, the page says so in words ("ADMIN_SECRET is not set on
 *   this server"): the same one bit. It also carries `staleSession`: whether the
 *   visitor's own request came with an admin-secret session cookie that does not
 *   work, so the page can ask for it to be deleted. It is about that cookie alone and
 *   is false for a visitor without one, as every request here is.
 * - On Setup only, and only before the first admin exists: the six stops' fixed names
 *   and whether each is done. The two live setups without an admin hold different
 *   facts (peers, times, events, which secrets are set) behind the same six answers,
 *   and must still be sent the same page and the same page data. Demo mode never has an admin, so its three
 *   setups show the six names with none done. With the list comes the generator for
 *   the two random settings (e2e/generate.spec.ts): it names those two, in the same
 *   bytes on every setup that shows it. Once an admin exists ("live-admin"),
 *   Setup is the sign-in prompt alone again.
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
/** Setup, the admin web's first page. */
const SETUP = "/admin";
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

// A script that carries a piece of the page data in the HTML: a JSON string.
const DATA_SCRIPT =
  /<script>self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)<\/script>/g;

/** The HTML as rendered: all of it but the scripts that carry the page data. */
const rendered = (html: string) => html.replaceAll(DATA_SCRIPT, "");

/** The page data the HTML carries, decoded and put together again. */
const inlineData = (html: string) =>
  [...html.matchAll(DATA_SCRIPT)]
    .map((m) => JSON.parse(m[1]) as string)
    .join("");

/** Page data as its rows, in an order that does not depend on when each was sent. */
const rows = (data: string) => data.split("\n").sort();

/** Two answers to the same page are the same, but for the order of the stream. */
function expectSame(b: Wire, a: Wire, what: string) {
  expect(rendered(b.html), `${what} (HTML)`).toBe(rendered(a.html));
  expect(rows(inlineData(b.html)), `${what} (page data in the HTML)`).toEqual(
    rows(inlineData(a.html)),
  );
  expect(rows(b.data), `${what} (page data)`).toEqual(rows(a.data));
}

/** The generator a visitor is shown with Setup's list: constants of the code. */
const GENERATOR =
  /<section class="card stack" aria-labelledby="generate-h">.*?<\/section>/s;
const lessGenerator = (html: string) => html.replace(GENERATOR, "");

/** What Setup adds for a visitor before the first admin exists, taken out. */
const lessProgress = (html: string) =>
  lessGenerator(html).replace(
    /<section class="stack" aria-labelledby="progress-h">.*?<\/section>/s,
    "",
  );

const STOPS = [
  "Environment",
  "Database",
  "Payments webhook",
  "Scheduled job",
  "First admin",
  "First peer",
];

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
      SETUP,
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
        // Before and after the first admin, Setup differs: tested on its own below.
        if (path === SETUP && other.admin !== first.admin) continue;
        const what = `${path}: ${first.name} and ${other.name}`;
        const a = sent.get(first.name)!.get(path)!;
        const b = sent.get(other.name)!.get(path)!;
        expectSame(b, a, what);
        // The comparison looked at page data, not at nothing.
        expect(inlineData(a.html).length, what).toBeGreaterThan(100);
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
      // The generator's two names are checked on their own, below.
      expectNoHints(lessGenerator(html), `${what} (HTML)`, setup);
      expectNoHints(data, `${what} (page data)`, setup);
    }

  // The generator is there exactly before the first admin, and the same everywhere:
  // across both modes, whatever each setup has set.
  const generators = SETUPS.map((setup) => {
    const { html } = sent.get(setup.name)!.get(SETUP)!;
    const found = GENERATOR.exec(html)?.[0];
    expect(found !== undefined, setup.name).toBe(!setup.admin);
    return found;
  }).filter((found) => found !== undefined);
  expect(new Set(generators).size).toBe(1);
  expect([...new Set(generators[0]!.match(VARIABLE))].sort()).toEqual([
    "CRON_SECRET",
    "OCPI_TOKEN_ENCRYPTION_KEY",
  ]);

  // Across the modes, a visitor is shown the same page but for the banner, and on
  // Setup but for the six names with their answers and the generator.
  const demo = sent.get("demo")!;
  for (const name of ["live-a", "live-admin"]) {
    const live = sent.get(name)!;
    for (const path of ROUTES) {
      // The sign-in page words its admin-secret step for a demo.
      if (path === SIGN_IN) continue;
      expect(demo.get(path)!.html, path).toContain('class="demo-banner"');
      expect(live.get(path)!.html, path).not.toContain("demo-banner");
      expect(
        lessProgress(shown(live.get(path)!.html)),
        `${path}: demo and ${name}, as shown`,
      ).toBe(lessProgress(shown(demo.get(path)!.html)));
    }
  }
});

/** The six stops a setup's visitor should be told, or null for none. */
const expectedView = (setup: Setup) =>
  setup.admin
    ? null
    : STOPS.map((name, i) => ({
        name,
        // Demo: none. The live setups without an admin: environment, database, peer.
        pass: setup.mode === "live" && [0, 1, 5].includes(i),
      }));

test("before the first admin a visitor is told six names and done or not; after it, nothing", async ({
  request,
  page,
}) => {
  test.setTimeout(120_000);
  for (const setup of SETUPS) {
    const what = `${setup.name} ${SETUP}`;
    const view = expectedView(setup);
    const html = await (await request.get(`${setup.url}${SETUP}`)).text();
    const data = plain(
      await (
        await request.get(`${setup.url}${SETUP}`, { headers: { RSC: "1" } })
      ).text(),
    );
    // What the server hands the page: exactly the view, or none.
    expect(data, what).toContain(`"publicView":${JSON.stringify(view)}`);
    expect(plain(html), what).toContain(`"publicView":${JSON.stringify(view)}`);
    const text = shown(html)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    if (!view) {
      // An admin exists: the view is gone, names and all.
      expect(text, what).not.toMatch(/Setup so far|Not done|No admin exists/);
      for (const name of STOPS.slice(1))
        expect(text.toLowerCase(), what).not.toContain(name.toLowerCase());
      expect(html, what).not.toContain("Setup progress");
      expect(html, what).not.toContain("Make the secret values");
      continue;
    }
    const done = view.filter((stop) => stop.pass).length;
    expect(text, what).toContain(`Setup so far: ${done} of 6 done`);
    for (const [i, stop] of view.entries())
      expect(text, what).toContain(
        `${i + 1} · ${stop.name.toUpperCase()} ${stop.pass ? "Done" : "Not done"}`,
      );
    for (const body of [html, data]) {
      // No time and nothing of what the database stand-in holds.
      expect(body, what).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:/);
      expect(body, what).not.toMatch(
        /Example CPO|cpo-\d|payment_intent|charge\.refunded|job\.run|webhook\.refused|since_last/,
      );
      expect(body, what).not.toMatch(/\.sql|emsp_|migrat/i);
    }
  }

  // As a visitor sees it, in a browser: the list, then the sign-in prompt.
  const fresh = SETUPS.find((s) => s.name === "live-b")!;
  await page.goto(`${fresh.url}${SETUP}`);
  const progress = page.getByRole("list", { name: "Setup progress" });
  await expect(progress.getByRole("listitem")).toHaveCount(6);
  await expect(progress.getByText("Not done")).toHaveCount(3);
  await expect(
    page.getByRole("heading", {
      name: "Sign in as an admin to see this deployment's setup",
    }),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: "Setup checklist" })).toHaveCount(
    0,
  );
  // The menu calls it Setup for every visitor.
  await expect(page.getByRole("link", { name: "Health" })).toHaveCount(0);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(
      page,
      `setup, before the first admin, ${colorScheme}`,
    );
  }
  const after = SETUPS.find((s) => s.name === "live-admin")!;
  await page.goto(`${after.url}${SETUP}`);
  await expect(
    page.getByRole("heading", {
      name: "Sign in as an admin to see this deployment's setup",
    }),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: "Setup progress" })).toHaveCount(
    0,
  );
});

test("the status API says live only where the database check passes, and nothing more", async ({
  request,
}) => {
  for (const setup of SETUPS) {
    const body = await (await request.get(`${setup.url}/api/v1/status`)).json();
    expect(Object.keys(body).sort(), setup.name).toEqual([
      "mode",
      "name",
      "ocpi",
    ]);
    expect(body.mode, setup.name).toBe(setup.mode);
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
      // No cookie came with the request, so there is none to delete.
      expect(body, what).toContain('"staleSession":false');
      // A demo without the admin secret says so in words: the same bit, by name.
      // In the HTML, that is: the page data carries the flag alone.
      const says =
        setup.mode === "demo" && !setup.secret && !("RSC" in headers);
      expect(
        body.includes("ADMIN_SECRET is not set on this server"),
        what,
      ).toBe(says);
      expect(
        (body.match(VARIABLE) ?? []).filter(
          (name) => !(says && name === "ADMIN_SECRET"),
        ),
        what,
      ).toEqual([]);
      // That sentence aside, nothing reads like a setting's error.
      expect(
        body.replaceAll("ADMIN_SECRET is not set on this server", ""),
        what,
      ).not.toMatch(ERROR_TEXT);
      expect(body, what).not.toMatch(
        /stripeKey|stripeSet|webhookSecret|cronSecret|"missing"/,
      );
      if (setup.mode === "live" && !("RSC" in headers)) bodies.push(body);
    }
  // The live setups (live-a, live-b, live-admin) differ on this page by that flag and
  // what it shows, only: the two with the secret set are sent the same bytes, whether
  // an admin exists or not.
  expect(bodies.length).toBe(3);
  expect(bodies[0]).not.toBe(bodies[1]);
  expect(bodies[2]).toBe(bodies[0]);
});

test("with the admin secret, the pages say how to find what the server did not send", async ({
  page,
}) => {
  // An admin-secret session is not a person on the admin list: the server renders the
  // settings into a page for an email sign-in only, and the pages say how to check by
  // hand.
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
  // The setup status is an admin action, and the secret is this server's admin gate:
  // the stops say what they found, by name. What the server renders into the page
  // (its address, its party, the hold) it still sends to an email sign-in only.
  const stop = page.locator("#stop-1");
  await expect(stop).toContainText("settings need you");
  await expect(stop).toContainText("PUBLIC_BASE_URL is not set.");
  await expect(stop).toContainText("HOLD_AMOUNTS must be");
  const main = page.getByRole("main");
  await expect(main).not.toContainText(/localhost|Hold per charge/);
  for (const value of Object.values(wrong.env))
    if (value.length > 3) await expect(main).not.toContainText(value);
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
