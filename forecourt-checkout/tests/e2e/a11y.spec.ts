import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// axe over the main screens, in light and dark, plus the 390 px no-sideways-scroll check.

async function check(page: Page, path: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(path);
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
}

test("public screens pass axe", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/", "/c/DEMO-1/1", "/c/DEMO-1/1/counter", "/nowhere"])
    await check(page, path);
});

test("staff screens pass axe", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/operator/login");
  await page.getByLabel("Password").fill("demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /today/ })).toBeVisible();
  for (const path of ["/operator", "/operator/prices", "/operator/faults"])
    await check(page, path);
  await page.goto("/cashier/login");
  await page.getByLabel("Cashier password").fill("demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("list", { name: "Chargers" })).toBeVisible();
  await check(page, "/cashier");
});
