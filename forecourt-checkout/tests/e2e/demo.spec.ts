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
  await expect(page.getByText("1000 bps")).toBeVisible();
  await shot(page, "operator");

  await page.getByRole("link", { name: "Prices" }).click();
  await expect(page.getByLabel("Energy, cents per kWh")).toHaveValue("45");
  await page.getByRole("button", { name: "Save prices" }).click();
  await expect(
    page.getByText("Demo mode: prices are not saved."),
  ).toBeVisible();

  await page.getByRole("link", { name: "Faults" }).click();
  await expect(page.getByText("GroundFailure")).toBeVisible();
});
