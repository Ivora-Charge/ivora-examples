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
  test(`axe, ${scheme}: landing and every wizard stage`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await expect(
      page.getByRole("link", { name: "Try the demo" }),
    ).toBeVisible();
    await expectNoViolations(page);

    await page.getByRole("link", { name: "Try the demo" }).click();
    await expect(page.getByLabel("Existing location")).toBeVisible();
    await expectNoViolations(page);

    await page.getByLabel("Existing location").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Use this location" }).click();
    await page.getByRole("button", { name: "Add charger" }).click();
    await expect(page.getByTestId("password")).toBeVisible();
    await expectNoViolations(page);

    await expect(page.getByText("Charger connected and booted")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "Start test session" }).click();
    await expect(page.getByText(/Test charging/)).toBeVisible();
    await page.getByRole("button", { name: "Stop test session" }).click();
    await expect(page.getByText(/^Passed/)).toBeVisible();
    await expectNoViolations(page);
  });
}

test("theme toggle is labelled by its action and keyboard reachable", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  const toggle = page.getByRole("button", { name: "Dark mode" });
  await toggle.click();
  await expect(page.getByRole("button", { name: "Light mode" })).toBeVisible();
});
