import { expect, test } from "@playwright/test";

// Runs only on the server with FLEET_MODULE off (see playwright.config.ts): the
// optional Cards module is out of the menu, its pages answer 404, and the rest of the
// kit doesn't point at it.

test("demo, Cards module off: no Cards in the menu, its pages are not found", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  if (isMobile) await nav.getByRole("button", { name: "Menu" }).click();
  await expect(nav.getByRole("link", { name: /^Pricing/ })).toBeVisible();
  await expect(nav.getByRole("link", { name: /^Cards/ })).toHaveCount(0);

  for (const path of ["/cards", "/cards/token-1"]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
  }

  await page.goto("/pricing");
  await expect(
    page.getByRole("heading", { level: 1, name: "Pricing" }),
  ).toBeVisible();
  await expect(
    page.locator("main").getByRole("link", { name: "Cards" }),
  ).toHaveCount(0);
});
