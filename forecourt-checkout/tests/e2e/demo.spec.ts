import { expect, test, type Page } from "@playwright/test";

// The demo end to end in a phone-sized browser, with no credentials. Set
// SCREENSHOTS=1 to refresh the README images in docs/.

const shot = async (page: Page, name: string) => {
  if (process.env.SCREENSHOTS)
    await page.screenshot({ path: `docs/${name}.png`, fullPage: true });
};

test("driver: scan, pay, charge, move the car, receipt", async ({ page }) => {
  // Any request leaving the machine would fail the test.
  const external: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("http://localhost:3110")) external.push(r.url());
  });

  await page.goto("/");
  await expect(page.getByText("Demo mode")).toBeVisible();
  await page.getByRole("link", { name: /Demo charger 1 · CCS/ }).click();

  await expect(
    page.getByRole("heading", { name: /CCS · connector 1/ }),
  ).toBeVisible();
  await expect(page.getByText("$0.45 per kWh")).toBeVisible();
  await expect(page.getByText("$0.40 per minute")).toBeVisible();
  await expect(
    page.getByRole("row", { name: /Estimated total \$16\.00/ }),
  ).toBeVisible();
  await shot(page, "charger");

  await page
    .getByRole("button", { name: /Pay with demo card \(\$50\.00 hold\)/ })
    .click();
  await expect(page.getByRole("heading", { name: "Charging" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("energy")).not.toHaveText(/^0\.00/);
  await shot(page, "charging");

  // The simulated car is full after about 50 seconds.
  await expect(page.getByTestId("move-car")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("idle-countdown")).toBeVisible();
  await shot(page, "move-car");

  await page.getByRole("button", { name: "Unplug car (demo)" }).click();
  await expect(page.getByRole("heading", { name: "Receipt" })).toBeVisible();
  await expect(
    page.getByRole("row", { name: /Charged to your card/ }),
  ).toBeVisible();
  await expect(page.getByRole("row", { name: /Hold released/ })).toBeVisible();
  await shot(page, "receipt");

  await page.getByRole("link", { name: "Printable receipt" }).click();
  await expect(
    page.getByRole("heading", { name: "Charging receipt" }),
  ).toBeVisible();
  await expect(
    page.getByText("Demo receipt: nothing was charged"),
  ).toBeVisible();

  expect(external).toEqual([]);
});

test("driver: stop early, then the receipt asks to move the car", async ({
  page,
}) => {
  await page.goto("/c/DEMO-1/2");
  await page.getByRole("button", { name: /Pay with demo card/ }).click();
  await expect(page.getByRole("heading", { name: "Charging" })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Stop charging" }).click();
  await expect(page.getByRole("heading", { name: "Receipt" })).toBeVisible();
  await expect(page.getByText(/Please move your car/)).toBeVisible();
});

test("driver: the CAD demo charger shows CA$ end to end", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /Demo charger 11/ }).click();
  await expect(page.getByText("CA$0.52 per kWh")).toBeVisible();
  await expect(page.getByText("CA$0.50 per minute")).toBeVisible();
  await expect(
    page.getByRole("row", { name: /Estimated total CA\$\d+\.\d\d/ }),
  ).toBeVisible();
  await expect(page.getByText(/US\$|(^|[^A])\$\d/)).toHaveCount(0);
  await shot(page, "charger-cad");
  await page
    .getByRole("button", { name: /Pay with demo card \(CA\$50\.00 hold\)/ })
    .click();
  await expect(page.getByRole("heading", { name: "Charging" })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Stop charging" }).click();
  await expect(page.getByRole("heading", { name: "Receipt" })).toBeVisible();
  await expect(
    page.getByRole("row", { name: /Charged to your card CA\$/ }),
  ).toBeVisible();
});

test("driver: a busy connector can't be paid for", async ({ page }) => {
  await page.goto("/c/DEMO-2/1");
  await expect(
    page.getByRole("button", { name: "Connector not available" }),
  ).toBeDisabled();
});

test("operator: password, today, prices and faults", async ({ page }) => {
  await page.goto("/operator");
  await expect(page).toHaveURL(/\/operator\/login/);
  await page.getByLabel("Password").fill("wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Wrong password.")).toBeVisible();
  await page.getByLabel("Password").fill("demo");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: /today/ })).toBeVisible();
  await expect(page.getByText("1000 bps").first()).toBeVisible();
  // USD and CAD are reported apart, never added together.
  await expect(page.getByText(/Mixed currencies/)).toBeVisible();
  await expect(page.getByLabel("Totals in CAD")).toContainText("CA$34.92");
  await expect(page.getByLabel("Totals in USD")).toContainText("$");
  await shot(page, "operator");

  await page.getByRole("link", { name: "Prices" }).click();
  await expect(page.getByLabel("Energy per kWh (USD, 1 = $0.01)")).toHaveValue(
    "45",
  );
  // The CAD tariff shows its own currency next to every field.
  await expect(
    page.getByRole("heading", { name: /Tariff 9002/ }),
  ).toContainText("CAD");
  await expect(
    page.getByLabel("Energy per kWh (CAD, 1 = CA$0.01)"),
  ).toHaveValue("52");
  await page.getByRole("button", { name: "Save prices" }).first().click();
  await expect(
    page.getByText("Demo mode: prices are not saved."),
  ).toBeVisible();

  await page.getByRole("link", { name: "Faults" }).click();
  await expect(page.getByText("GroundFailure")).toBeVisible();
});
