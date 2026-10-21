import { expect, test, type Page } from "@playwright/test";

// Demo mode: signed in as the labelled demo owner, with two sample tariffs on the
// sample chargers. Each test gets a fresh browser context, so fresh demo prices (they
// live in the visitor's cookie). Previews are priced offline by the demo stand-in for
// Ivora's simulation; nothing is sent to Ivora.

async function openPricing(page: Page, isMobile: boolean) {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  if (isMobile) await nav.getByRole("button", { name: "Menu" }).click();
  await nav.getByRole("link", { name: /^Pricing/ }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Pricing" }),
  ).toBeVisible();
}

test("demo: create a tariff with time-of-use and an idle fee, preview it and save a new version", async ({
  page,
  isMobile,
}) => {
  await openPricing(page, isMobile);
  await expect(
    page.getByRole("list", { name: "Tariffs", exact: true }),
  ).toContainText("Sample: Standard");
  await page.getByRole("link", { name: "New tariff" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "New tariff" }),
  ).toBeVisible();

  await page.getByLabel("Tariff name").fill("Evening");
  await page.getByLabel("Price per kWh (USD)", { exact: true }).fill("0.35");
  await page.getByLabel("Session fee (USD, optional)").fill("1.00");
  await page.getByLabel("Idle fee per minute (USD, optional)").fill("0.40");
  await expect(page.getByLabel("Idle grace period (minutes)")).toHaveValue(
    "10",
  );
  await page.getByRole("button", { name: "Add a time-of-use period" }).click();
  const period = page.getByRole("group", { name: "Period 1", exact: true });
  await expect(period.getByLabel("From")).toHaveValue("16:00");
  await expect(period.getByLabel("Until")).toHaveValue("21:00");
  await expect(period.getByLabel("Mon")).toBeChecked();
  await expect(period.getByLabel("Sat")).not.toBeChecked();
  await period.getByLabel("Period 1 price per kWh (USD)").fill("0.45");

  // A 30 kWh session on a Tuesday from 18:00 to 20:30, then 15 idle minutes.
  await page.getByLabel("Date").fill("2026-10-20");
  await page.getByRole("button", { name: "Preview price" }).click();
  const quote = page.getByRole("region", { name: /Preview/ });
  await expect(quote).toContainText(
    "A 30 kWh session on Tue, Oct 20, 2026 from 18:00 to 20:30 (UTC), then 15 idle minutes costs $16.50.",
  );
  await expect(quote.getByTestId("quote-total")).toHaveText("$16.50");
  await expect(quote).toContainText("Energy, period 1 (Mon–Fri 16:00–21:00)");
  await expect(quote).toContainText(
    "Idle fee (5 of 15 idle minutes; the first 10 are free)",
  );
  await expect(quote).toContainText("Demo");
  // A preview keeps what was typed.
  await expect(page.getByLabel("Tariff name")).toHaveValue("Evening");

  await page.getByRole("button", { name: "Create tariff" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Evening" }),
  ).toBeVisible();
  await expect(page.getByText(/Tariff created in Ivora/)).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Version 1/ })).toBeVisible();

  // A change is a new version; the old one is replaced, never edited.
  await page.getByLabel("Price per kWh (USD)", { exact: true }).fill("0.40");
  await page.getByRole("button", { name: "Save as a new version" }).click();
  await expect(page.getByText(/Version 2 is live/)).toBeVisible();
  await page.reload();
  const versions = page.getByRole("list", { name: "Versions" });
  await expect(versions.getByRole("listitem")).toHaveCount(2);
  await expect(versions.getByRole("listitem").first()).toContainText(
    "Version 2",
  );
  await expect(versions.getByRole("listitem").first()).toContainText("In use");
  await expect(versions.getByRole("listitem").nth(1)).toContainText(
    "Replaced (archived in Ivora)",
  );
});

test("demo: a free tariff, and form problems shown before saving", async ({
  page,
  isMobile,
}) => {
  await openPricing(page, isMobile);
  await page.getByRole("link", { name: "New tariff" }).click();
  await page.getByLabel("Tariff name").fill("Staff");
  await page.getByLabel("Price per kWh (USD)", { exact: true }).fill("0.355");
  await page.getByRole("button", { name: "Preview price" }).click();
  await expect(page.locator("p.error")).toContainText("at most 2 decimals");

  await page.getByLabel("Free: zero price, no card hold").check();
  await expect(
    page.getByLabel("Price per kWh (USD)", { exact: true }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Preview price" }).click();
  await expect(page.getByTestId("quote-total")).toHaveText("$0.00");
  await page.getByRole("button", { name: "Create tariff" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Staff" }),
  ).toBeVisible();
  await expect(page.getByText("None (free)")).toBeVisible();
});

test("demo: assign tariffs per charger and connector; a private charger has no QR checkout", async ({
  page,
  isMobile,
}) => {
  await openPricing(page, isMobile);
  const stations = page.getByRole("list", {
    name: "Chargers and their tariffs",
  });
  const harbour2 = stations
    .getByRole("listitem")
    .filter({ hasText: "DEMO-HARBOUR-02" })
    .first();
  await expect(harbour2).toContainText(
    "Connector 2: Sample: Free staff charging (its own)",
  );
  const market = stations
    .getByRole("listitem")
    .filter({ hasText: "DEMO-MARKET-01" })
    .first();
  await expect(market).toContainText("Private");

  // DEMO-HARBOUR-01: free for the charger, the standard price on connector 2.
  const harbour1 = stations
    .getByRole("listitem")
    .filter({ hasText: "DEMO-HARBOUR-01" })
    .first();
  await harbour1.getByText("Change").click();
  await harbour1
    .getByLabel("Tariff for DEMO-HARBOUR-01")
    .selectOption({ label: "Sample: Free staff charging" });
  await harbour1
    .getByLabel("Connector 2")
    .selectOption({ label: "Sample: Standard" });
  await harbour1
    .getByRole("button", { name: "Save prices for DEMO-HARBOUR-01" })
    .click();
  await expect(
    harbour1.getByText("Prices saved for DEMO-HARBOUR-01."),
  ).toBeVisible();
  await page.reload();
  const again = page
    .getByRole("list", { name: "Chargers and their tariffs" })
    .getByRole("listitem")
    .filter({ hasText: "DEMO-HARBOUR-01" })
    .first();
  await expect(again).toContainText(
    "Connector 1: Sample: Free staff charging (the charger's)",
  );
  await expect(again).toContainText("Connector 2: Sample: Standard (its own)");

  // The private charger's sticker leads to no checkout.
  await page.goto("/chargers/station-9103");
  await page.getByRole("button", { name: "Create sticker codes" }).click();
  const url = (await page
    .getByRole("article")
    .first()
    .locator(".sticker-url")
    .textContent())!;
  await page.goto(new URL(url).pathname);
  await expect(page.getByText(/This is a private charger/)).toBeVisible();

  // A public one shows its price.
  await page.goto("/chargers/station-9101");
  await page.getByRole("button", { name: "Create sticker codes" }).click();
  const url2 = (await page
    .getByRole("article")
    .nth(1)
    .locator(".sticker-url")
    .textContent())!;
  await page.goto(new URL(url2).pathname);
  await expect(page.getByText(/\$0\.35 per kWh/)).toBeVisible();
});
