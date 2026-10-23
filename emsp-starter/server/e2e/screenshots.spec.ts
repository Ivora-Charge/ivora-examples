import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_ADMIN_SECRET } from "../playwright.config";

/**
 * The READMEs' admin screenshots, on demand only: SCREENSHOT=1 npm run test:e2e --
 * screenshots. Demo mode, offline: docs/admin-<page>-<desktop|phone>-<light|dark>.png,
 * the whole page on desktop and the screen, scrolled to the result, on a phone.
 */
test.skip(!process.env.SCREENSHOT, "only with SCREENSHOT=1");
// Chromium sometimes fails the first capture of a cold server; a picture is safe to retake.
test.describe.configure({ retries: 2 });

/** Scrolls the result near the top of the screen, with its button above it. */
const top = (l: Locator) =>
  l.evaluate((el) => {
    el.scrollIntoView({ block: "start" });
    window.scrollBy(0, -88);
  });

const PAGES: [string, string, (page: Page) => Promise<void>][] = [
  [
    "overview",
    "/",
    async (page) => {
      await expect(page.getByText("DMO", { exact: true })).toBeVisible();
    },
  ],
  [
    "peers",
    "/admin/peers",
    async (page) => {
      const list = page.getByRole("region", { name: "Peers and their status" });
      await list.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
      await list.getByRole("button", { name: "Show peers" }).click();
      await expect(list).toContainText("Mock CPO (demo, built in)");
      await top(list.getByRole("status"));
    },
  ],
  [
    "sessions",
    "/admin/sessions",
    async (page) => {
      const list = page.getByRole("region", {
        name: "Live and recent sessions",
      });
      await list.getByLabel("Status").selectOption("all");
      await list.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
      await list.getByRole("button", { name: "Show sessions" }).click();
      await expect(list.getByRole("status")).toContainText("session(s)");
      await top(list.getByRole("status"));
    },
  ],
  [
    "reconciliation",
    "/admin/reconciliation",
    async (page) => {
      const card = page.getByRole("region", { name: "Reconcile" });
      await card.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
      await card.getByRole("button", { name: "Reconcile" }).click();
      await expect(card.getByRole("status")).toContainText("mismatch(es)");
      await top(card.getByRole("status"));
    },
  ],
];

for (const scheme of ["light", "dark"] as const)
  for (const [name, path, show] of PAGES)
    test(`screenshot: admin ${name}, ${scheme}`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(path);
      await show(page);
      // No focus ring or caret on the picture.
      await page.evaluate(() =>
        (document.activeElement as HTMLElement)?.blur(),
      );
      const device = info.project.name === "mobile" ? "phone" : "desktop";
      // Desktop pages end just below their result: show the whole page there.
      await page.screenshot({
        path: `docs/admin-${name}-${device}-${scheme}.png`,
        fullPage: device === "desktop",
      });
    });
