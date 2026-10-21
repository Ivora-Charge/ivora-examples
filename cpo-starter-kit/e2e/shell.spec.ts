import { expect, test } from "@playwright/test";

const SECTIONS = ["Live", "Pricing", "Reports"];

// Runs on the desktop and mobile projects (see playwright.config.ts).
test("demo: overview shows labelled sample data", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("status").filter({ hasText: "Demo" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("DEMO-HARBOUR-01")).toBeVisible();
  await expect(
    page.locator("main").getByText("Sample", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Chargers online")).toBeVisible();
  await expect(
    page.getByText("Demo mode: add your Ivora API key in settings to go live"),
  ).toBeVisible();

  if (process.env.SCREENSHOT)
    await page.screenshot({ path: "docs/screenshot.png", fullPage: false });
});

test("demo: every unbuilt section is reachable from the menu and marked coming soon", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  const menu = nav.getByRole("button", { name: "Menu" });

  for (const name of SECTIONS) {
    if (isMobile) {
      await expect(menu).toHaveAttribute("aria-expanded", "false");
      await menu.click();
      await expect(menu).toHaveAttribute("aria-expanded", "true");
    } else {
      await expect(menu).toBeHidden();
    }
    await nav.getByRole("link", { name: new RegExp(`^${name}`) }).click();
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(page.getByText("Coming soon", { exact: true })).toBeVisible();
    await expect(page).toHaveTitle(new RegExp(`^${name} · `));
    if (!isMobile)
      await expect(
        nav.getByRole("link", { name: new RegExp(`^${name}`) }),
      ).toHaveAttribute("aria-current", "page");
    // The demo banner stays on every page.
    await expect(
      page.getByRole("status").filter({ hasText: "Demo" }),
    ).toBeVisible();
  }
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
