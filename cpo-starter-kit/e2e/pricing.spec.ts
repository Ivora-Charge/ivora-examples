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
  // The free minutes are the simulation's (Ivora's rule), not the browser's.
  await expect(quote).toContainText("Idle fee (after 10 free minutes)");
  await expect(quote).toContainText("while charging is paused");
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

test("demo: an overnight Friday period prices Saturday's early hours, and a long session warns about the hold", async ({
  page,
  isMobile,
}) => {
  await openPricing(page, isMobile);
  await page.getByRole("link", { name: "New tariff" }).click();
  await page.getByLabel("Tariff name").fill("Night");
  await page.getByLabel("Price per kWh (USD)", { exact: true }).fill("0.35");
  await page.getByRole("button", { name: "Add a time-of-use period" }).click();
  const period = page.getByRole("group", { name: "Period 1", exact: true });
  await period.getByLabel("From").fill("22:00");
  await period.getByLabel("Until").fill("06:00");
  for (const d of ["Mon", "Tue", "Wed", "Thu"])
    await period.getByLabel(d).uncheck();
  await period.getByLabel("Period 1 price per kWh (USD)").fill("0.20");

  // Saturday 24 October 2026, 01:00 to 03:00: still Friday night's price.
  await page.getByLabel("Date").fill("2026-10-24");
  await page.getByLabel("Charging from").fill("01:00");
  await page.getByLabel("Until", { exact: true }).last().fill("03:00");
  await page.getByLabel("Energy (kWh)").fill("10");
  await page.getByLabel("Then idle (minutes)").fill("0");
  await page.getByRole("button", { name: "Preview price" }).click();
  const quote = page.getByRole("region", { name: /Preview/ });
  await expect(quote).toContainText("Energy, period 1 (Fri 22:00–06:00)");
  await expect(quote.getByTestId("quote-total")).toHaveText("$2.00");

  // 60 kWh at $0.35, 20 idle minutes at $0.40 after 10 free: more than the hold.
  await page.getByLabel("Idle fee per minute (USD, optional)").fill("0.40");
  await page.getByLabel("Date").fill("2026-10-20");
  await page.getByLabel("Charging from").fill("10:00");
  await page.getByLabel("Until", { exact: true }).last().fill("14:00");
  await page.getByLabel("Energy (kWh)").fill("80");
  await page.getByLabel("Then idle (minutes)").fill("20");
  await page.getByRole("button", { name: "Preview price" }).click();
  await expect(quote.getByTestId("quote-total")).toHaveText("$32.00");
  await expect(quote.getByRole("note")).toContainText(
    "more than the $25.00 card hold",
  );
});

test("demo: a stale tariff editor or charger form is refused instead of undoing a newer change", async ({
  page,
  context,
  isMobile,
}) => {
  await openPricing(page, isMobile);
  const tariffUrl = await page
    .getByRole("link", { name: "Sample: Standard", exact: true })
    .getAttribute("href");
  // Two tabs on the same tariff (the demo keeps prices in this browser's cookie).
  const other = await context.newPage();
  await other.goto(tariffUrl!);
  await page.goto(tariffUrl!);
  await page.getByLabel("Price per kWh (USD)", { exact: true }).fill("0.45");
  await page.getByRole("button", { name: "Save as a new version" }).click();
  await expect(page.getByText(/Version 2 is live/)).toBeVisible();
  await other.getByLabel("Idle fee per minute (USD, optional)").fill("0.50");
  await other.getByRole("button", { name: "Save as a new version" }).click();
  await expect(other.locator("p.error")).toContainText(
    "Someone changed this tariff after you opened it",
  );

  // Two tabs on the Pricing page: one makes DEMO-HARBOUR-01 private first.
  await page.goto("/pricing");
  await other.goto("/pricing");
  const harbour = (p: Page) =>
    p
      .getByRole("list", { name: "Chargers and their tariffs" })
      .getByRole("listitem")
      .filter({ hasText: "DEMO-HARBOUR-01" })
      .first();
  await harbour(page).getByText("Change").click();
  await harbour(page)
    .getByLabel(/Private charger/)
    .check();
  await harbour(page)
    .getByRole("button", { name: "Save prices for DEMO-HARBOUR-01" })
    .click();
  await expect(
    harbour(page).getByText("Prices saved for DEMO-HARBOUR-01."),
  ).toBeVisible();
  await harbour(other).getByText("Change").click();
  await harbour(other)
    .getByRole("button", { name: "Save prices for DEMO-HARBOUR-01" })
    .click();
  await expect(harbour(other).locator("p.error")).toContainText(
    "Someone changed this charger",
  );
  await page.reload();
  await expect(harbour(page)).toContainText("Private");
});
