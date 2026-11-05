import { expect, test } from "@playwright/test";

// Demo mode: the CAD sample site ("Sample Site: Waterfront (CAD)", DEMO-WATERFRONT-01)
// next to the USD ones. Amounts are formatted for English (US) readers, so Canadian
// dollars read "CA$" and US dollars "$". Nothing is charged or sent anywhere.

test("demo: the CAD tariff shows CA$ and its editor says CAD", async ({
  page,
}) => {
  await page.goto("/pricing");
  const cad = page.getByRole("link", { name: "Sample: Standard (CAD)" });
  await expect(cad).toBeVisible();
  await expect(page.getByText(/CA\$0\.40 per kWh/).first()).toBeVisible();
  await expect(page.getByText(/(^|[^A])\$0\.35 per kWh/).first()).toBeVisible();
  await cad.click();
  await expect(page.getByText(/CA\$25\.00/).first()).toBeVisible();
  await expect(
    page.getByLabel("Price per kWh (CAD)", { exact: true }),
  ).toHaveValue("0.40");
  await expect(page.getByLabel("Session fee (CAD, optional)")).toHaveValue(
    "1.50",
  );
});

test("demo: the CAD editor previews in CA$, and Save shows the USD-only note", async ({
  page,
}) => {
  await page.goto("/pricing");
  await page.getByRole("link", { name: "Sample: Standard (CAD)" }).click();
  const note =
    "Paid tariffs can be saved in USD only for now; this CAD sample shows how other currencies read.";
  // Next to the Paid/Free choice before anything is pressed, and only while Paid.
  await expect(page.getByTestId("paid-currency-note")).toHaveText(note);
  await page.getByLabel("Free: zero price, no card hold").check();
  await expect(page.getByTestId("paid-currency-note")).toHaveCount(0);
  await page.getByLabel("Paid: drivers pay per kWh").check();

  await page.getByRole("button", { name: "Preview price" }).click();
  const quote = page.getByRole("region", { name: /Preview/ });
  await expect(quote.getByTestId("quote-total")).toHaveText(/^CA\$\d+\.\d\d$/);

  await page.getByRole("button", { name: "Save as a new version" }).click();
  const alert = page.locator("form p.error[role=alert]");
  await expect(alert).toContainText(note);
  await expect(alert).not.toContainText("Settings");
});

test("demo: a driver pays in CAD from the Waterfront sticker and gets a CA$ receipt", async ({
  page,
}) => {
  await page.goto("/chargers/station-9104");
  await page.getByRole("button", { name: "Create sticker codes" }).click();
  const url = (await page
    .getByRole("article")
    .first()
    .locator(".sticker-url")
    .textContent())!;
  await page.goto(new URL(url).pathname);
  await expect(page.getByText(/CA\$0\.40 per kWh/)).toBeVisible();
  await expect(page.getByTestId("example-total")).toHaveText(/^CA\$\d+\.\d\d$/);
  await page
    .getByRole("button", {
      name: "Pay and charge with a demo card (CA$25.00 hold)",
    })
    .click();
  await page
    .getByRole("button", { name: "Pay with demo card (CA$25.00 hold)" })
    .click();
  const mine = page.getByRole("region", { name: "Your session" });
  await expect(mine.locator("strong").first()).toHaveText("Charging", {
    timeout: 15_000,
  });
  await mine.getByRole("button", { name: "Stop charging" }).click();
  await expect(mine.locator("strong").first()).toHaveText("Finished");
  await expect(mine.getByTestId("receipt-charged")).toHaveText(
    /^CA\$\d+\.\d\d$/,
  );
});

test("demo: reports show USD and CAD side by side, never added together", async ({
  page,
}) => {
  await page.goto("/reports");
  const figures = page.getByRole("region", { name: "Figures for the period" });
  await expect(figures).toContainText(/CA\$\d/);
  await expect(figures).toContainText(/(^|[^A])\$\d/);
  await expect(figures).toContainText("Mixed currencies (CAD, USD)");
});
