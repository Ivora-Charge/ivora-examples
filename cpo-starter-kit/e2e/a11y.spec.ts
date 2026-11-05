import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Axe over the main screens, light and dark, and no sideways scroll at 390 px. Runs on
// both servers (Cards on and off) so the menu is checked either way. Cards and
// Roaming have their own specs.

const PAGES = [
  "/welcome",
  "/",
  "/onboarding",
  "/chargers",
  "/live",
  "/pricing",
  "/reports",
  "/team",
  "/settings",
  "/settings/roaming",
  "/chargers/station-9101",
  "/live/stations/9102",
  "/pricing/new",
  "/pricing/demo-standard",
  "/login",
  "/setup",
  "/invite",
  "/no-such-page",
];

async function checkPage(page: Page, label: string) {
  await page.waitForLoadState("networkidle");
  // The title must be there before axe looks (document-title), as it is for a screen
  // reader or a browser tab.
  await expect(page, `${label} has a title`).toHaveTitle(/.+/);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`),
    label,
  ).toEqual([]);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, `${label} scrolls sideways`).toBeLessThanOrEqual(0);
}

test("main screens pass axe in light and dark and do not scroll sideways on a phone", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of PAGES)
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(path);
      await checkPage(page, `${path} (${scheme})`);
    }
});

test("main screens do not scroll sideways on a tablet or a desktop", async ({
  page,
}) => {
  test.setTimeout(120_000);
  for (const width of [768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const path of PAGES) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `${path} at ${width} px`).toBeLessThanOrEqual(0);
    }
  }
});

async function createSticker(page: Page) {
  await page.goto("/chargers/station-9101");
  await page.getByRole("button", { name: "Create sticker codes" }).click();
  const url = await page.locator(".sticker-url").first().textContent();
  return new URL(url!).pathname;
}

/** The <title> of a response, only if it sits in the first HTML, inside <head>. */
function headTitle(html: string) {
  return /<head[\s>][\s\S]*<title>([^<]+)<\/title>[\s\S]*<\/head>/.exec(
    html,
  )?.[1];
}

test("driver pages send their title in the first HTML response", async ({
  page,
}) => {
  const sticker = await createSticker(page);
  // A browser's user agent, so Next does not treat the request as a bot.
  const headers = {
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/120",
  };
  const res = await page.request.get(sticker, { headers });
  expect(headTitle(await res.text()), sticker).toMatch(/^Charge here · .+/);
  const unknown = await page.request.get("/c/no-such-code", { headers });
  expect(headTitle(await unknown.text()), "unknown code").toMatch(/.+ · .+/);

  await page.goto(sticker);
  await page.getByRole("button", { name: /^Pay and charge/ }).click();
  await expect(page).toHaveURL(/\/demo\/checkout\//);
  const checkout = await page.request.get(page.url(), { headers });
  expect(headTitle(await checkout.text()), "demo checkout").toMatch(
    /^Demo checkout · .+/,
  );
});

test("driver pages pass axe in light and dark and do not scroll sideways on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const sticker = await createSticker(page);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(sticker);
    await checkPage(page, `sticker page (${scheme})`);
  }
  await page.getByRole("button", { name: /^Pay and charge/ }).click();
  await expect(page).toHaveURL(/\/demo\/checkout\//);
  await checkPage(page, "demo checkout");
});

test("missing pages answer 404, outside and inside the staff app", async ({
  page,
}) => {
  for (const path of [
    "/no-such-page",
    "/live/stations/abc",
    "/cards/abc",
    // Well-formed but unknown: the lookup runs before anything streams.
    "/chargers/no-such-charger",
    "/chargers/no-such-charger/stickers",
    "/pricing/no-such-tariff",
    "/live/stations/99999",
    "/cards/99999",
    "/demo/checkout/nope",
  ]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
    await expect(
      page.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeVisible();
  }
});

test("the landing page leads into the demo", async ({ page }) => {
  await page.goto("/welcome");
  await expect(page.getByText("Demo mode:")).toBeVisible();
  await page
    .getByRole("main")
    .getByRole("link", { name: "Try the demo" })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Overview" }),
  ).toBeVisible();
});
