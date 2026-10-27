import { expect, test, type Page } from "@playwright/test";

// README screenshot set, from the demo: `npm run screenshots`. Light and dark,
// desktop (1440 px) and phone (390 px), written to docs/screens/. Skipped in
// normal runs. One session is driven once, then each stage is captured in all
// four looks by resizing and switching the colour scheme.

const LOOKS = [
  ["desktop", "light", 1440, 900],
  ["desktop", "dark", 1440, 900],
  ["phone", "light", 390, 844],
  ["phone", "dark", 390, 844],
] as const;

async function capture(page: Page, name: string) {
  for (const [device, scheme, width, height] of LOOKS) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.screenshot({
      path: `docs/screens/${name}-${device}-${scheme}.png`,
      fullPage: true,
    });
  }
}

test("screenshot set", async ({ page }) => {
  test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to regenerate");
  test.setTimeout(240_000);

  await page.goto("/");
  await capture(page, "home");
  await page.goto("/c/DEMO-1/1");
  await capture(page, "charger");

  await page.getByRole("button", { name: /Pay with demo card/ }).click();
  await expect(page.getByRole("heading", { name: "Charging" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("energy")).not.toHaveText(/^0\.00/);
  await capture(page, "charging");
  await expect(page.getByTestId("move-car")).toBeVisible({ timeout: 90_000 });
  await capture(page, "move-car");
  await page.getByRole("button", { name: "Unplug car (demo)" }).click();
  await expect(page.getByRole("heading", { name: "Receipt" })).toBeVisible();
  await capture(page, "receipt");

  await page.goto("/c/DEMO-1/1/counter");
  await capture(page, "counter");

  await page.goto("/operator/login");
  await page.getByLabel("Password").fill("demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /today/ })).toBeVisible();
  await capture(page, "operator");
  await page.goto("/operator/prices");
  // Both tariff cards, not the loading skeleton.
  await expect(page.getByRole("heading", { name: /Tariff 9002/ })).toBeVisible({
    timeout: 15_000,
  });
  await capture(page, "prices");
  await page.goto("/operator/faults");
  await capture(page, "faults");

  await page.goto("/cashier/login");
  await page.getByLabel("Cashier password").fill("demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("list", { name: "Chargers" })).toBeVisible();
  await capture(page, "cashier");
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.screenshot({
    path: "docs/screens/cashier-tablet-landscape.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.screenshot({
    path: "docs/screens/cashier-tablet-portrait.png",
    fullPage: true,
  });
});
