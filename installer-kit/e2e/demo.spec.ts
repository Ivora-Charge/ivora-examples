import { expect, test } from "@playwright/test";

test("demo: site, charger, connection, test, config, price and hand-over", async ({
  page,
}) => {
  await page.goto("/commission");
  await expect(page.getByText(/DEMO MODE/)).toBeVisible();

  // 1. Site
  await page.getByLabel("Site name").fill("Sample Depot (demo)");
  await page.getByLabel("Street address").fill("1 Example Way");
  await page.getByLabel("City").fill("Springfield");
  await page.getByRole("button", { name: "Create site" }).click();

  // 2. Add charger: the password is shown once.
  await expect(
    page.getByLabel("Connection name (charge point ID)"),
  ).toHaveValue(/^ik-/);
  await page.getByLabel("Connectors").fill("2");
  const created = page.waitForResponse("**/api/chargers");
  await page.getByRole("button", { name: "Add charger" }).click();
  const { charger, password } = await (await created).json();
  await expect(page.getByTestId("password")).toHaveText(password);
  await expect(page.getByRole("img", { name: /connection URL/ })).toBeVisible();

  // 3. The simulated charger connects and boots a few seconds later.
  await expect(page.getByText("Charger connected and booted")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("DemoCharge (simulated)")).toBeVisible();

  // Later reads never contain the password.
  const later = await page.request.get(`/api/chargers/${charger.id}`);
  expect(await later.text()).not.toContain(password);
  await page.getByRole("button", { name: "Hide" }).click();
  await expect(page.getByTestId("password")).toHaveCount(0);
  await expect(page.getByText(password)).toHaveCount(0);

  // 4. Test session and configuration read-back.
  await page.getByRole("button", { name: "Start test session" }).click();
  await expect(page.getByText(/Test charging/)).toBeVisible();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Stop test session" }).click();
  await expect(page.getByText(/^Passed/)).toBeVisible();
  await expect(page.getByText("Test session (not billed).")).toBeVisible();
  await page.getByRole("button", { name: "Read configuration" }).click();
  await expect(page.getByText("300 s")).toBeVisible();
  await page.getByLabel("Seconds").fill("120");
  await page.getByRole("button", { name: "Apply and read back" }).click();
  await expect(page.getByText("Charger answered Accepted.")).toBeVisible();
  await expect(page.getByText("120 s")).toBeVisible();

  // 5. Price
  await page.getByLabel("Price per kWh (USD minor units)").fill("40");
  await expect(page.getByText("$8.00")).toBeVisible();
  await page.getByRole("button", { name: "Add to report" }).click();

  // 6. Hand-over: links, not buttons inside links.
  const sticker = page.getByRole("link", { name: /Sticker PDF, connector 2/ });
  await expect(sticker).toBeVisible();
  expect(await page.locator("a button").count()).toBe(0);
  const pdf = await page.request.get((await sticker.getAttribute("href"))!);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  const report = await page.request.get(`/api/chargers/${charger.id}/report`);
  expect((await report.body()).subarray(0, 5).toString()).toBe("%PDF-");

  // Mark in service: recorded with its time; a stale test start is refused.
  await page.getByRole("button", { name: "Mark in service" }).click();
  await expect(page.getByText(/In service since 20/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start test session" }),
  ).toBeDisabled();
  const stale = await page.request.post(`/api/chargers/${charger.id}/test`, {
    data: { action: "start", connector: 1 },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error).toBe("in_service");

  // README screenshot of the finished demo (wizard state lives in the page).
  if (process.env.SCREENSHOT) {
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.screenshot({ path: process.env.SCREENSHOT, fullPage: true });
  }

  // The sticker's landing page resolves the code on this domain.
  const code = /\((\w{8})\)/.exec((await sticker.textContent())!)![1];
  await page.goto(`/s/${code}`);
  await expect(page.getByText(/connector\s+2/)).toBeVisible();
});

test("demo: a CAD site prices in CA$ with the currency next to the field", async ({
  page,
}) => {
  await page.goto("/commission");
  await page.getByLabel("Existing location").selectOption({
    label: "Sample Annex Toronto (demo) (5 Example St, Toronto)",
  });
  await page.getByRole("button", { name: "Use this location" }).click();
  await page.getByRole("button", { name: "Add charger" }).click();
  await expect(page.getByText("Charger connected and booted")).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Start test session" }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Stop test session" }).click();
  await expect(page.getByText(/^Passed/)).toBeVisible();
  await expect(page.getByLabel("Currency")).toHaveValue("CAD");
  await page.getByLabel("Price per kWh (CAD minor units)").fill("40");
  await expect(page.getByText("CA$8.00")).toBeVisible();
  await expect(page.getByText("40 = CA$0.40 per kWh")).toBeVisible();
  await page.getByRole("button", { name: "Add to report" }).click();
  await expect(page.getByText("CA$0.40 / kWh")).toBeVisible();
});
