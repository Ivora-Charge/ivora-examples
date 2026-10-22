import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

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
  "/no-such-page",
];

test("main screens pass axe in light and dark and do not scroll sideways on a phone", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of PAGES)
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(
        results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`),
        `${path} (${scheme})`,
      ).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(0);
    }
});

test("the landing page leads into the demo", async ({ page }) => {
  await page.goto("/welcome");
  await expect(page.getByText("Demo mode:")).toBeVisible();
  await page.getByRole("link", { name: "Try the demo" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Overview" }),
  ).toBeVisible();
});
