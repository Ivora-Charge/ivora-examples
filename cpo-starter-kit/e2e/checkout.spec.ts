import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Demo mode: a driver scans a sticker, pays with the demo's stand-in for Stripe
// Checkout, comes back to the sticker's page, follows and stops the session and gets a
// demo receipt; on a free connector, starts a free session. Each test gets a fresh
// browser context (fresh demo cookies). Nothing is charged and nothing is sent to
// Ivora, Stripe or a charger.

/** The sticker page of DEMO-HARBOUR-01's connector 1 (paid, "Sample: Standard"). */
async function openSticker(page: Page) {
  await page.goto("/chargers/station-9101");
  await page.getByRole("button", { name: "Create sticker codes" }).click();
  const url = (await page
    .getByRole("article")
    .first()
    .locator(".sticker-url")
    .textContent())!;
  const path = new URL(url).pathname;
  await page.goto(path);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /DEMO-HARBOUR-01, connector 1/,
    }),
  ).toBeVisible();
  return path;
}

test("demo: pay and charge from a sticker, follow and stop the session, get a receipt", async ({
  page,
}) => {
  const sticker = await openSticker(page);
  await expect(page.getByText("Demo sticker: simulated charger")).toBeVisible();
  await expect(page.getByText(/\$0\.35 per kWh/)).toBeVisible();
  await expect(page.getByTestId("example-total")).toHaveText(/^\$\d+\.\d\d$/);
  await expect(page.locator(".charge-board .pill")).toHaveText("Available");

  await page
    .getByRole("button", {
      name: "Pay and charge with a demo card ($25.00 hold)",
    })
    .click();
  await expect(page).toHaveURL(/\/demo\/checkout\/pay_demo_/);
  await expect(
    page.getByText("this page stands in for Stripe Checkout"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Pay with demo card ($25.00 hold)" })
    .click();

  // Back on the sticker's page: the charger starts, the car "plugs in".
  await expect(page).toHaveURL(sticker);
  const mine = page.getByRole("region", { name: "Your session" });
  await expect(mine.locator("strong").first()).toHaveText("Charging", {
    timeout: 15_000,
  });
  await expect(mine).toContainText(/stops by itself at about \$22\.50/);
  // While it runs, this browser can't start a second one here.
  const pay = page.getByRole("region", { name: "Pay and charge" });
  await expect(pay.getByText(/You already have a session/)).toBeVisible();
  await expect(
    pay.getByRole("button", { name: "Not available right now" }),
  ).toBeDisabled();

  await mine.getByRole("button", { name: "Stop charging" }).click();
  await expect(mine.locator("strong").first()).toHaveText("Finished");
  const receipt = mine.getByRole("definition").first();
  await expect(receipt).toHaveText(/^\$\d+\.\d\d$/);
  await expect(mine.getByTestId("receipt-charged")).toHaveText(/^\$\d+\.\d\d$/);
  await expect(mine).toContainText("Hold released");
  await expect(mine).toContainText("no card was charged");
  // The connector is free again.
  await expect(
    pay.getByRole("button", { name: /Pay and charge with a demo card/ }),
  ).toBeEnabled();
});

test("demo: clear errors for an offline charger, a connector in use and Stripe not ready", async ({
  page,
}) => {
  await openSticker(page);
  const pay = page.getByRole("region", { name: "Pay and charge" });
  for (const [option, message, pill] of [
    ["The charger is offline", "This charger is offline right now", "Offline"],
    ["The connector is in use", "This connector is in use", "In use"],
    [
      "The operator's Stripe account isn't ready",
      "can't take card payments here yet",
      "Available",
    ],
  ]) {
    await page.getByLabel("What this sticker page sees").selectOption({
      label: option,
    });
    await page.getByRole("button", { name: "Simulate" }).click();
    await expect(pay.getByRole("alert")).toContainText(message);
    await expect(
      pay.getByRole("button", { name: "Not available right now" }),
    ).toBeDisabled();
    await expect(page.locator(".charge-board .pill")).toHaveText(pill);
  }
  await page.getByLabel("What this sticker page sees").selectOption({
    label: "Nothing: the charger is free and Stripe is ready",
  });
  await page.getByRole("button", { name: "Simulate" }).click();
  await expect(
    pay.getByRole("button", { name: /Pay and charge with a demo card/ }),
  ).toBeEnabled();
});

test("demo: a private charger and a free connector have no card checkout", async ({
  page,
}) => {
  await page.goto("/chargers/station-9103");
  await page.getByRole("button", { name: "Create sticker codes" }).click();
  const priv = (await page
    .getByRole("article")
    .first()
    .locator(".sticker-url")
    .textContent())!;
  await page.goto(new URL(priv).pathname);
  await expect(page.getByText(/This is a private charger/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Pay and charge/ }),
  ).toHaveCount(0);

  // DEMO-HARBOUR-02's connector 2 uses "Sample: Free staff charging".
  await page.goto("/chargers/station-9102");
  await page.getByRole("button", { name: "Create sticker codes" }).click();
  const free = (await page
    .getByRole("article")
    .nth(1)
    .locator(".sticker-url")
    .textContent())!;
  await page.goto(new URL(free).pathname);
  await expect(page.getByText(/Charging here is free/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Pay and charge/ }),
  ).toHaveCount(0);
});

test("demo: start and stop a free session, with no payment", async ({
  page,
}) => {
  // Make DEMO-HARBOUR-01's connector 2 (Available) free to use.
  await page.goto("/pricing");
  const harbour1 = page
    .getByRole("list", { name: "Chargers and their tariffs" })
    .getByRole("listitem")
    .filter({ hasText: "DEMO-HARBOUR-01" })
    .first();
  await harbour1.getByText("Change").click();
  await harbour1
    .getByLabel("Connector 2")
    .selectOption({ label: "Sample: Free staff charging" });
  await harbour1
    .getByRole("button", { name: "Save prices for DEMO-HARBOUR-01" })
    .click();
  await expect(
    harbour1.getByText("Prices saved for DEMO-HARBOUR-01."),
  ).toBeVisible();

  await page.goto("/chargers/station-9101");
  await page.getByRole("button", { name: "Create sticker codes" }).click();
  const url = (await page
    .getByRole("article")
    .nth(1)
    .locator(".sticker-url")
    .textContent())!;
  await page.goto(new URL(url).pathname);
  await expect(page.getByText(/Charging here is free/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Pay and charge/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Start free session" }).click();
  const mine = page.getByRole("region", { name: "Your session" });
  await expect(mine).toContainText("Charging (free)", { timeout: 15_000 });
  await mine.getByRole("button", { name: "Stop charging" }).click();
  await expect(mine).toContainText("Your free session has ended");
});

test("driver pages pass axe on a phone, in light and dark", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const sticker = await openSticker(page);
  await page
    .getByRole("button", { name: /Pay and charge with a demo card/ })
    .click();
  await expect(page).toHaveURL(/\/demo\/checkout\//);
  const checkout = new URL(page.url()).pathname;
  for (const path of [sticker, checkout, "/c/ZZZZ2345"])
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(path);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(
        results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`),
        `${path} (${scheme})`,
      ).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(0);
    }
});
