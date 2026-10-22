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

test("the admin web uses the self-hosted brand fonts", async ({ page }) => {
  await page.goto("/");
  const heading = page.getByRole("heading", { name: "Overview" });
  await expect(heading).toBeVisible();
  const family = (l: ReturnType<typeof page.locator>) =>
    l.evaluate((el) => getComputedStyle(el).fontFamily);
  // next/font names each family after its constant in brand/fonts.ts, ahead of the
  // token's name.
  expect(await family(heading)).toMatch(/^\W*\w*bricolage/i);
  expect(await family(page.locator("body"))).toMatch(/^\W*\w*instrument/i);
  expect(await family(page.locator("code").first())).toMatch(/^\W*\w*mono/i);
  expect(
    await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((f) => f.status === "loaded")
        .map((f) => f.family);
    }),
  ).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/bricolage/i),
      expect.stringMatching(/instrument/i),
    ]),
  );
});
