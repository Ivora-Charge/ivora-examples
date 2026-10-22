import { expect, test, type Page } from "@playwright/test";

// Demo mode: a driver scans a sticker, pays with the demo's stand-in for Stripe
// Checkout, follows the session on the stand-in for Ivora's driver page and gets a
// demo receipt. Each test gets a fresh browser context (fresh demo cookies). Nothing
// is charged and nothing is sent to Ivora, Stripe or a charger.

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

test("demo: pay and charge from a sticker, follow the session and get a receipt", async ({
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

  // The stand-in for Ivora's driver page: the charger starts, the car "plugs in".
  await expect(page).toHaveURL(/\/demo\/charging\//);
  await expect(
    page.getByText("this page stands in for Ivora's driver page"),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: "Charging" }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Stop charging" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Finished" }),
  ).toBeVisible();
  const receipt = page.getByRole("region", { name: "Receipt (demo)" });
  await expect(receipt).toContainText("Card hold released");
  await expect(receipt.getByTestId("receipt-total")).toHaveText(
    /^\$\d+\.\d\d$/,
  );
  await expect(receipt).toContainText("no card was charged");

  // Back on the sticker's page, the driver sees their own session.
  await page.getByRole("link", { name: "Back to the charger" }).click();
  await expect(page).toHaveURL(sticker);
  const mine = page.getByRole("region", { name: "Your session" });
  await expect(mine).toContainText("Finished");
  await expect(mine).toContainText("kWh");
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
