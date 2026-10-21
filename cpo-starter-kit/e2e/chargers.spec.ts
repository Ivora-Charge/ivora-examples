import { expect, test, type Page } from "@playwright/test";

// Demo mode: signed in as the labelled demo owner. Each test gets a fresh browser
// context, so a fresh demo fleet (the visitor's own chargers live in their cookie).
// Nothing is sent to Ivora or a charger: the demo client simulates the charger.

async function openChargers(page: Page, isMobile: boolean) {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  if (isMobile) await nav.getByRole("button", { name: "Menu" }).click();
  await nav.getByRole("link", { name: /^Chargers/ }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Chargers" }),
  ).toBeVisible();
}

test("demo: add a charger, test it, print its stickers and remove it", async ({
  page,
  isMobile,
}) => {
  await openChargers(page, isMobile);
  const list = page.getByRole("list", { name: "Chargers" });
  await expect(list).toContainText("DEMO-HARBOUR-01");

  // Add, with a new site. The password is shown once, with the connection URL.
  await page
    .getByLabel("Connection name (charge point ID)")
    .fill("DEMO-BAY-01");
  await page.getByLabel("Display name (optional)").fill("Bay 1");
  await page.getByLabel("Connectors").selectOption("2");
  await page.getByLabel("Site").selectOption("new");
  await page.getByLabel("Site name").fill("North Depot");
  await page.getByRole("button", { name: "Add charger" }).click();
  await expect(page.getByText(/Bay 1 is registered/)).toBeVisible();
  await expect(
    page.getByText(/Demo: simulated, nothing was sent/),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Password" })).toHaveValue(
    /^[A-Za-z0-9]{24}$/,
  );
  await expect(
    page.getByRole("textbox", { name: "OCPP connection URL" }),
  ).toHaveValue("wss://ocpp.demo.example/DEMO-BAY-01");
  await expect(
    page.getByRole("textbox", { name: "Charge point ID (username)" }),
  ).toHaveValue("DEMO-BAY-01");
  await page.getByRole("link", { name: "Open the charger to test it" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Bay 1" }),
  ).toBeVisible();
  // Shown once: the charger page has only "set by the kit".
  await expect(
    page.getByText("Set by the kit (not shown again)"),
  ).toBeVisible();

  // Connection test: the simulated charger connects and boots a few seconds later.
  const conn = page.getByRole("region", { name: /Connection test/ });
  await expect(async () => {
    await conn
      .getByRole("button", { name: /Run (connection test|again)/ })
      .click();
    await expect(conn.getByText("Connection test passed.")).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 20_000 });
  await expect(
    conn.getByRole("list", { name: "Connection test results" }),
  ).not.toContainText("Fail");

  // Remote test: needs the "this starts the charger" confirmation.
  await page.reload();
  const remote = page.getByRole("region", {
    name: /Remote start and stop test/,
  });
  await expect(
    remote.getByText("This starts the charger.", { exact: true }),
  ).toBeVisible();
  await remote.getByLabel("Connector").selectOption("2");
  await remote.getByRole("button", { name: "Start the test" }).click();
  // Without the confirmation the browser refuses to send it.
  expect(
    await remote
      .getByLabel("I understand this starts the charger.")
      .evaluate((el) => (el as HTMLInputElement).validity.valid),
  ).toBe(false);
  await expect(remote.getByText(/Start sent|Charging \(/)).toHaveCount(0);
  await remote.getByLabel("I understand this starts the charger.").check();
  await remote.getByRole("button", { name: "Start the test" }).click();
  // The card follows the session: charging, then passed once stopped.
  await expect(remote.getByText("Test 1, connector 2: charging")).toBeVisible();
  await remote.getByRole("button", { name: "Stop the test" }).click();
  await expect(remote.getByText(/Test 1, connector 2: passed/)).toBeVisible();
  await expect(remote.getByRole("heading", { name: /Passed/ })).toBeVisible();

  // Stickers: a stable code per connector on this deployment's own address.
  await page.reload();
  await page.getByRole("button", { name: "Create sticker codes" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: /QR stickers: Bay 1/ }),
  ).toBeVisible();
  const stickers = page.getByRole("article");
  await expect(stickers).toHaveCount(2);
  await expect(stickers.first()).toContainText("Demo, not for printing");
  await expect(stickers.first().locator("svg")).toBeVisible();
  const url = (await stickers.first().locator(".sticker-url").textContent())!;
  expect(url).toMatch(/\/c\/[A-HJ-NP-Z2-9]{8}$/);
  await page.goto(new URL(url).pathname);
  await expect(
    page.getByRole("heading", { name: "Charge here" }),
  ).toBeVisible();
  await expect(page.getByText(/Bay 1, connector 1/)).toBeVisible();

  // Edit, then remove: it charged, so Ivora keeps it and the kit hides it.
  await openChargers(page, isMobile);
  await page
    .getByRole("list", { name: "Chargers" })
    .getByRole("link", { name: "Bay 1" })
    .click();
  await page.getByLabel("Display name", { exact: true }).fill("Bay 1 north");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Charger saved/)).toBeVisible();
  const remove = page.getByRole("region", { name: "Remove" });
  await expect(remove).toContainText("has charging history");
  await remove.getByLabel(/I understand, remove/).check();
  await remove.getByRole("button", { name: "Remove charger" }).click();
  await expect(
    page.getByText(/Ivora keeps it because it has charging history/),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: "Chargers" })).not.toContainText(
    "Bay 1",
  );
  await page.goto(new URL(url).pathname);
  await expect(page.getByText(/not in service/)).toBeVisible();
});

test("demo: a sample charger that never charged is deleted in Ivora", async ({
  page,
  isMobile,
}) => {
  await openChargers(page, isMobile);
  await page.getByRole("link", { name: "DEMO-MARKET-01" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "DEMO-MARKET-01" }),
  ).toBeVisible();
  // Offline: no remote test until it is connected.
  await expect(page.getByText(/The charger is offline/)).toBeVisible();
  const remove = page.getByRole("region", { name: "Remove" });
  await remove.getByLabel(/I understand, remove/).check();
  await remove.getByRole("button", { name: "Remove charger" }).click();
  await expect(
    page.getByText("Charger removed, and deleted in Ivora.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: "Chargers" })).not.toContainText(
    "DEMO-MARKET-01",
  );
  await page
    .getByRole("button", { name: "Demo: reset chargers to the samples" })
    .click();
  await expect(page.getByRole("list", { name: "Chargers" })).toContainText(
    "DEMO-MARKET-01",
  );
});
