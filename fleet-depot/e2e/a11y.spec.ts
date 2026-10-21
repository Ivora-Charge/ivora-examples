import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function expectNoViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`),
  ).toEqual([]);
}

for (const scheme of ["light", "dark"] as const) {
  test(`axe, ${scheme}: landing, every depot tab and the wall display`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await expectNoViolations(page);
    await page.getByRole("link", { name: "Try the demo" }).click();
    await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
    await expectNoViolations(page);
    for (const tab of ["Vehicles and cards", "Sessions and cost", "Settings"]) {
      await page.getByRole("tab", { name: tab }).click();
      await expectNoViolations(page);
    }
    await page.getByRole("button", { name: /Wall display/ }).click();
    await expect(
      page.getByRole("heading", { name: "Departures" }),
    ).toBeVisible();
    await expectNoViolations(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
  });
}

test("phone: no sideways scroll and vehicle rows have now and departure labels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  for (const path of ["/", "/depot"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    for (const tab of [
      "Vehicles and cards",
      "Sessions and cost",
      "Settings",
    ].slice(0, path === "/" ? 0 : 3)) {
      await page.getByRole("tab", { name: tab }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  }
  await page.getByRole("tab", { name: "Overview" }).click();
  const first = page.locator(".row").first();
  await expect(first.locator(".tl-now")).toContainText(/now/);
  await expect(first).toContainText(/dep/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("tabs work from the keyboard", async ({ page }) => {
  await page.goto("/depot");
  await page.getByRole("tab", { name: "Overview" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Vehicles and cards" }),
  ).toBeFocused();
  await expect(
    page.getByRole("tab", { name: "Vehicles and cards" }),
  ).toHaveAttribute("aria-selected", "true");
});
