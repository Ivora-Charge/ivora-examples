import { expect, test, type Page } from "@playwright/test";
import { goTo, signIn, type Place } from "./support";

/**
 * The READMEs' admin screenshots, on demand only: SCREENSHOT=1 npm run test:e2e --
 * screenshots. Demo mode, offline: docs/admin-<page>-<desktop|phone>-<light|dark>.png,
 * the whole page on desktop and the screen on a phone.
 */
test.skip(!process.env.SCREENSHOT, "only with SCREENSHOT=1");
// Chromium sometimes fails the first capture of a cold server; a picture is safe to retake.
test.describe.configure({ retries: 2 });

/** Signed in with the demo's admin secret, on a place of the menu, with its list open. */
const at =
  (place: Place, ready: (page: Page) => Promise<void>) =>
  async (page: Page) => {
    await signIn(page);
    await goTo(page, place);
    await ready(page);
  };

const PAGES: [string, (page: Page) => Promise<void>][] = [
  [
    "setup",
    at("Setup", async (page) => {
      await expect(page.locator("#stop-6")).toContainText("mock CPO");
    }),
  ],
  [
    "sign-in",
    async (page) => {
      await page.goto("/admin/sign-in");
      await page.getByLabel("Email").fill("ana@example.com");
      await page.getByRole("button", { name: "Email me a code" }).click();
      await expect(page.getByLabel("6-digit code")).toBeVisible();
    },
  ],
  [
    "signed-out",
    async (page) => {
      await page.goto("/admin/peers");
      await expect(
        page.getByRole("heading", { name: /^Sign in as an admin/ }),
      ).toBeVisible();
    },
  ],
  [
    "peers",
    at("Peers", async (page) => {
      await expect(page.getByRole("list", { name: "Peers" })).toContainText(
        "Mock CPO",
      );
    }),
  ],
  [
    "connect",
    at("Peers", async (page) => {
      await page.getByRole("link", { name: "Connect a peer" }).click();
      await page
        .getByRole("button", { name: /A roaming hub gave me a one-time token/ })
        .click();
      await expect(page.getByLabel("One-time token")).toBeVisible();
    }),
  ],
  [
    "sessions",
    at("Sessions", async (page) => {
      await expect(page.locator("table.data tbody tr")).toHaveCount(3);
    }),
  ],
  [
    "problems",
    at("Problems", async (page) => {
      await expect(
        page.getByRole("group", { name: "Show" }).getByRole("button").first(),
      ).toBeVisible();
      await expect(page.getByText("Loading…")).toHaveCount(0);
    }),
  ],
  [
    "payments",
    at("Payments", async (page) => {
      await expect(
        page.getByRole("region", { name: "To review" }).getByRole("status"),
      ).toBeVisible();
    }),
  ],
  [
    "reconciliation",
    at("Reconciliation", async (page) => {
      await expect(
        page.getByRole("region", { name: "Mismatches" }),
      ).toBeVisible();
    }),
  ],
  [
    "drivers",
    at("Drivers and tokens", async (page) => {
      await page.getByLabel("Driver reference").fill("demo-driver");
      await page.getByRole("button", { name: "Find driver" }).click();
      await expect(page.getByRole("region", { name: "Tokens" })).toContainText(
        "token(s)",
      );
    }),
  ],
];

for (const scheme of ["light", "dark"] as const)
  for (const [name, show] of PAGES)
    test(`screenshot: admin ${name}, ${scheme}`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      await show(page);
      await page.evaluate(() => document.fonts.ready);
      // No focus ring or caret on the picture.
      await page.evaluate(() =>
        (document.activeElement as HTMLElement)?.blur(),
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      const device = info.project.name === "mobile" ? "phone" : "desktop";
      await page.screenshot({
        path: `docs/admin-${name}-${device}-${scheme}.png`,
        fullPage: device === "desktop",
      });
    });
