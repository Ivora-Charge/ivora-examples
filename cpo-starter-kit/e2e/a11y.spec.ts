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

test("driver pages pass axe in light and dark and do not scroll sideways on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/chargers/station-9101");
  await page.getByRole("button", { name: "Create sticker codes" }).click();
  const url = await page.locator(".sticker-url").first().textContent();
  const sticker = new URL(url!).pathname;
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
  for (const path of ["/no-such-page", "/live/stations/abc", "/cards/abc"]) {
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
