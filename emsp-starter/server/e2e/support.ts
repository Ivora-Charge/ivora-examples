import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { E2E_ADMIN_SECRET } from "../playwright.config";

/**
 * Demo mode has no admin accounts, so the e2e admin uses ADMIN_SECRET: typed once on
 * the sign-in page and kept in the page's memory. A reload (page.goto) forgets it, so
 * after signIn() move between pages with goTo(), which follows the menu's links.
 */
export async function signIn(page: Page, secret = E2E_ADMIN_SECRET) {
  await page.goto("/admin/sign-in");
  await page
    .getByRole("button", { name: "Use the admin secret instead" })
    .click();
  await page.getByLabel("Admin secret").fill(secret);
  await page.getByRole("button", { name: "Continue" }).click();
  if (secret === E2E_ADMIN_SECRET)
    await expect(
      page.getByRole("heading", { name: "Account", level: 1 }),
    ).toBeVisible();
}

export type Place =
  | "Setup"
  | "Peers"
  | "Sessions"
  | "Problems"
  | "Payments"
  | "Reconciliation"
  | "Drivers and tokens"
  | "Account";

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 960;

/** Opens a place from the menu: the rail on desktop, the tab bar or "More" on a phone. */
export async function goTo(page: Page, place: Place) {
  if (!isPhone(page)) {
    await page
      .getByRole("navigation", { name: "Admin", exact: true })
      .getByRole("link", { name: place, exact: true })
      .click();
    return;
  }
  const tabs = page.getByRole("navigation", { name: "Admin, phone" });
  if (place === "Setup" || place === "Peers" || place === "Sessions")
    await tabs.getByRole("link", { name: place, exact: true }).click();
  else if (place === "Payments")
    await tabs.getByRole("link", { name: "Money", exact: true }).click();
  else {
    await tabs.getByText("More", { exact: true }).click();
    await tabs
      .getByRole("link", {
        name: place === "Account" ? "Account and sign out" : place,
        exact: true,
      })
      .click();
  }
}

/** Axe (WCAG 2.1 A and AA) on the page as it is now, and no sideways scroll. */
export async function expectAccessible(page: Page, label: string) {
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
