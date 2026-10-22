import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Charging from the app's web build, in its offline demo (the mock CPO's sample
 * chargers, nothing sent anywhere): enter a charger's ID, confirm the price, the hold
 * and the card, watch it charge, stop it, read the receipt, and the card that declines
 * a higher hold. Map tiles are blocked, as in home.spec.ts.
 */
const TILES = /tiles\.openfreemap\.org/;

async function signedIn(page: Page) {
  const external: string[] = [];
  page.on("request", (r) => {
    const url = r.url();
    if (
      !url.startsWith("http://localhost:") &&
      !TILES.test(url) &&
      !url.startsWith("blob:") &&
      !url.startsWith("data:")
    )
      external.push(url);
  });
  await page.route(TILES, (r) => r.abort());
  // `expo serve` has no rewrite for deep links: start at the root.
  await page.goto("/");
  await page.getByTestId("tab-account").click();
  await page.getByTestId("email-input").fill("driver@example.com");
  await page.getByTestId("send-code").click();
  await page.getByTestId("code-input").fill("000000");
  await page.getByTestId("verify-code").click();
  await expect(page.getByTestId("signed-in-email")).toBeVisible();
  return external;
}

async function scan(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .exclude(".maplibregl-canvas")
    .analyze();
  return violations
    .filter((v) => v.impact !== "minor")
    .map(
      (v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`,
    );
}

async function startAt(page: Page, code: string) {
  await page.getByTestId("tab-charging").click();
  await page.getByTestId("charging-start").click();
  await page.getByTestId("charger-code").fill(code);
  await page.getByTestId("charger-find").click();
  await expect(page.getByTestId("confirm-screen")).toBeVisible();
}

test("enter a charger's ID, confirm, charge, stop and read the receipt, sending nothing", async ({
  page,
}) => {
  const external = await signedIn(page);
  await startAt(page, "zz-mck-e11");
  await expect(page.getByTestId("confirm-place")).toHaveText("Station Square");
  // The scanned EVSE's connector is chosen; the price, the hold and the card are shown.
  await expect(
    page.getByRole("radio", { checked: true }).first(),
  ).toContainText("ZZ*MCK*E11");
  await expect(page.getByTestId("confirm-price")).toContainText("€0.71");
  await expect(page.getByTestId("confirm-hold")).toContainText("€25.00");
  await expect(page.getByTestId("confirm-card")).toContainText(
    "Visa •••• 4242",
  );
  await expect(page.getByText("Demo: no card is charged")).toBeVisible();
  expect(await scan(page)).toEqual([]);

  await page.getByTestId("confirm-start").click();
  await expect(page.getByTestId("live-charge")).toBeVisible();
  await expect(page.getByTestId("live-place")).toHaveText("Station Square");
  await expect(page.getByTestId("live-phase")).toHaveText("Charging");
  await expect(page.getByTestId("live-kwh")).not.toHaveText("0 kWh");
  await expect(page.getByTestId("live-readout")).toBeVisible();
  // The charge on the live card is not listed again, with older figures, below it.
  await expect(page.getByTestId("history-row")).toHaveCount(0);
  expect(await scan(page)).toEqual([]);

  await page.getByTestId("live-stop").click();
  await expect(page.getByTestId("live-phase")).toHaveText("Charging finished");
  await expect(page.getByTestId("live-finished")).toBeVisible();
  await page.getByTestId("live-receipt").click();

  await expect(page.getByTestId("receipt")).toBeVisible();
  await expect(
    page.getByText("Demo receipt: no card was charged."),
  ).toBeVisible();
  await expect(page.getByTestId("receipt-charged")).toContainText("€");
  await page.getByTestId("receipt-email").click();
  await expect(page.getByTestId("receipt-email-result")).toHaveText(
    "Demo: no email is sent.",
  );
  expect(await scan(page)).toEqual([]);

  await page.getByTestId("page-back").click();
  await page.getByTestId("tab-wallet").click();
  await expect(page.getByTestId("receipt-row")).toHaveCount(1);
  await page.getByTestId("tab-charging").click();
  await page.getByTestId("live-done").click();
  await expect(page.getByTestId("history-row").first()).toContainText(
    "Station Square",
  );
  expect(external).toEqual([]);
});

test("the card that declines a higher hold stops the session and says so, not as a charger fault", async ({
  page,
}) => {
  await signedIn(page);
  await page.getByTestId("tab-wallet").click();
  await page.getByTestId("card-0341").click();
  await expect(page.getByTestId("wallet-message")).toContainText(
    "Mastercard •••• 0341 now pays",
  );
  await startAt(page, "ZZ*MCK*E11");
  await expect(page.getByTestId("confirm-card")).toContainText("0341");
  await page.getByTestId("confirm-start").click();
  const reason = page.getByTestId("live-stopped-reason");
  await expect(reason).toBeVisible({ timeout: 45_000 });
  await expect(reason).toContainText(
    "Your card didn't approve more charging; session stopped at €25.00.",
  );
  await expect(reason).not.toContainText(/fault|out of order|broken/i);
  await page.getByTestId("live-receipt").click();
  await expect(page.getByTestId("receipt-stop-reason")).toContainText(
    "Your card didn't approve more charging",
  );
  await page.getByTestId("page-back").click();
  await page.getByTestId("live-done").click();
  await expect(page.getByTestId("history-row").first()).toContainText(
    "Stopped: your card didn't approve more charging",
  );
});

test("favourites and reporting a problem at a charger", async ({ page }) => {
  await signedIn(page);
  await page.getByTestId("tab-index").click();
  await page.getByTestId("place-Station Square").click();
  const star = page.getByTestId("favourite-toggle");
  await expect(star).toHaveAttribute("aria-checked", "false");
  await star.click();
  await expect(star).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("detail-report").click();

  await expect(page.getByTestId("report-screen")).toBeVisible();
  await page.getByTestId("report-send").click();
  await expect(page.getByTestId("report-error")).toHaveText(
    "Choose what went wrong.",
  );
  await page.getByTestId("category-damaged").click();
  await page.getByTestId("report-message").fill("The cable holder is broken.");
  expect(await scan(page)).toEqual([]);
  await page.getByTestId("report-send").click();
  await expect(page.getByTestId("report-sent")).toBeVisible();
  await page.getByTestId("report-done").click();
  // Phones show the charger as a page of its own: back to the tabs first.
  if ((page.viewportSize()?.width ?? 0) < 900)
    await page.getByTestId("detail-close").click();
  await page.getByTestId("tab-charging").click();
  await expect(page.getByTestId("favourite-row")).toHaveCount(1);
});
