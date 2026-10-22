import { expect, test } from "@playwright/test";

// Runs on the desktop and mobile projects (see playwright.config.ts).
test("demo: admin overview is labelled and shows the OCPI identity", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("status").filter({ hasText: "Demo" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("2.2.1")).toBeVisible();
  await expect(page.getByText("DMO", { exact: true })).toBeVisible();
  await expect(page).toHaveTitle(/admin$/);
});

test("demo: status API reports demo mode", async ({ request }) => {
  const res = await request.get("/api/v1/status");
  expect(res.ok()).toBe(true);
  expect(res.headers()["access-control-allow-origin"]).toBe("*");
  expect(await res.json()).toMatchObject({
    mode: "demo",
    ocpi: { version: "2.2.1" },
  });
});

test("skip link moves focus to the main content", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "keyboard navigation is a desktop flow");
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await skip.press("Enter");
  await expect(page.locator("main")).toBeFocused();
});
