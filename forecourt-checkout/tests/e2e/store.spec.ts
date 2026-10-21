import { expect, test, type Page } from "@playwright/test";

// Pay in store, end to end in demo mode on a desktop and a tablet: the
// cashier console, prepay with change, postpay with mark paid, the driver's
// "pay at the counter" screen and the printable receipt. No credentials, and
// no request leaves the machine. Set SCREENSHOTS=1 to refresh docs/ images.

const shot = async (page: Page, name: string) => {
  if (process.env.SCREENSHOTS && test.info().project.name === "tablet")
    await page.screenshot({ path: `docs/${name}.png`, fullPage: true });
};

function offline(page: Page) {
  const external: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("http://localhost:3110")) external.push(r.url());
  });
  return external;
}

// Logins are rate-limited per client, so only one test tries a wrong password.
async function signIn(page: Page, tryWrong = false) {
  await page.goto("/cashier");
  await expect(page).toHaveURL(/\/cashier\/login/);
  if (tryWrong) {
    await page.getByLabel("Cashier password").fill("wrong");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Wrong password.")).toBeVisible();
  }
  await page.getByLabel("Cashier password").fill("demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("list", { name: "Chargers" })).toBeVisible();
}

const tile = (page: Page, label: string, state: string) =>
  page.getByRole("listitem", { name: `${label}: ${state}` });

test("console shows every charger like a fuel pump, in every state", async ({
  page,
}) => {
  const external = offline(page);
  await signIn(page, true);
  for (const [label, state] of [
    ["Charger 1-1", "Available"],
    ["Charger 2-1", "Paying by card"],
    ["Charger 2-2", "Faulted"],
    ["Charger 3", "Plugged in"],
    ["Charger 5", "Charging"],
    ["Charger 6", "Done unpaid"],
    ["Charger 7", "Done unpaid"],
    ["Charger 8", "Paid"],
    ["Charger 9", "Offline"],
    ["Charger 10", "Charging"],
  ])
    await expect(tile(page, label, state)).toBeVisible();
  await shot(page, "cashier");

  // A session the console didn't start is flagged.
  await tile(page, "Charger 10", "Charging").click();
  await expect(
    page.getByRole("region", { name: "Charger 10" }).getByRole("alert"),
  ).toContainText("requires authorisation");

  // The prepaid overrun is shown, never collected on its own.
  await tile(page, "Charger 7", "Done unpaid").click();
  const seven = page.getByRole("region", { name: "Charger 7" });
  await expect(seven.getByTestId("overrun")).toContainText(
    /Used \$\d+\.\d\d more than prepaid/,
  );
  await expect(
    seven.getByRole("button", { name: /Mark extra \$\d+\.\d\d paid/ }),
  ).toBeVisible();

  // A cashier can't open the operator pages.
  await page.goto("/operator");
  await expect(page).toHaveURL(/\/operator\/login/);
  expect(external).toEqual([]);
});

test("postpay: authorise a plugged-in car, stop, mark paid, print", async ({
  page,
}) => {
  const external = offline(page);
  await signIn(page);
  await tile(page, "Charger 3", "Plugged in").click();
  const panel = page.getByRole("region", { name: "Charger 3" });
  await panel
    .getByRole("button", { name: "Authorise: pay after charging" })
    .click();
  await expect(tile(page, "Charger 3", "Charging")).toBeVisible({
    timeout: 15_000,
  });
  await expect(panel.getByTestId("sale-energy")).not.toHaveText(/^0\.00/);
  await panel.getByRole("button", { name: "Stop charging" }).click();
  await expect(tile(page, "Charger 3", "Done unpaid")).toBeVisible();
  await expect(panel.getByTestId("amount-due")).toContainText(/\$\d+\.\d\d/);

  await panel.getByLabel("Card on POS").check();
  await panel.getByLabel("POS reference (optional)").fill("1042");
  await panel.getByRole("button", { name: /^Mark \$\d+\.\d\d paid$/ }).click();
  await expect(tile(page, "Charger 3", "Paid")).toBeVisible();
  await expect(panel.getByTestId("paid")).toBeVisible();

  await panel.getByRole("link", { name: "Print receipt" }).click();
  const receipt = page.getByTestId("store-receipt");
  await expect(receipt).toContainText("Charger 3");
  await expect(receipt).toContainText("Paid in store (card)");
  await expect(receipt).toContainText("POS ref 1042");
  await expect(receipt).toContainText("DEMO: nothing was charged");
  await expect(
    page.getByRole("button", { name: "Print or save as PDF" }),
  ).toBeVisible();
  await shot(page, "store-receipt");
  expect(external).toEqual([]);
});

test("prepay with change, as the driver at the counter sees it", async ({
  page,
  context,
}) => {
  const external = offline(page);
  await signIn(page);

  // The driver scans the QR code and chooses to pay at the counter.
  const driver = await context.newPage();
  offline(driver);
  await driver.goto("/c/DEMO-4/1");
  await expect(
    driver.getByRole("button", { name: /Pay with demo card/ }),
  ).toBeVisible();
  await driver
    .getByRole("link", {
      name: "Pay at the counter: tell the cashier Charger 4",
    })
    .click();
  await expect(driver.getByTestId("counter-number")).toContainText("Charger 4");
  await expect(
    driver.getByRole("heading", { name: "Waiting for the cashier" }),
  ).toBeVisible();

  // The cashier takes $20 on the POS and starts the charger.
  await tile(page, "Charger 4", "Plugged in").click();
  const panel = page.getByRole("region", { name: "Charger 4" });
  await panel.getByRole("button", { name: "$20.00" }).click();
  await panel.getByRole("button", { name: "Start prepaid $20.00" }).click();
  await panel
    .getByRole("button", { name: "Confirm $20.00 paid and start" })
    .click();
  await expect(tile(page, "Charger 4", "Charging")).toBeVisible({
    timeout: 15_000,
  });

  await expect(driver.getByRole("heading", { name: "Charging" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(driver.getByText("of $20.00 prepaid")).toBeVisible();
  await shot(driver, "counter");

  // Charging stops itself before the prepaid amount runs out.
  await expect(tile(page, "Charger 4", "Done unpaid")).toBeVisible({
    timeout: 90_000,
  });
  await expect(panel.getByTestId("change")).toContainText(
    /Change owed: \$\d+\.\d\d/,
  );
  await expect(driver.getByTestId("counter-change")).toBeVisible({
    timeout: 10_000,
  });

  await panel.getByRole("button", { name: /Change given \$\d+\.\d\d/ }).click();
  await expect(tile(page, "Charger 4", "Paid")).toBeVisible();
  await expect(driver.getByText("Paid in store. Thank you!")).toBeVisible({
    timeout: 10_000,
  });

  await panel.getByRole("link", { name: "Print receipt" }).click();
  const receipt = page.getByTestId("store-receipt");
  await expect(receipt).toContainText("Prepaid$20.00");
  await expect(receipt).toContainText("Change given");
  expect(external).toEqual([]);
});

test("simulated POS: receives session_due and marks the sale paid", async ({
  page,
}) => {
  const external = offline(page);
  await signIn(page);
  const pos = page.getByRole("region", { name: "Simulated POS" });
  const six = pos.getByTestId("pos-event").filter({ hasText: "Charger 6" });
  await expect(six).toContainText("session_due");
  await expect(six).toContainText("signature verified");
  await expect(six).toContainText(/Due \$\d+\.\d\d/);
  await six.getByText("Webhook received").click();
  await expect(six.locator("pre")).toContainText("Forecourt-Signature: t=");
  await expect(six.locator("pre")).toContainText('"type": "session_due"');
  await expect(six.locator("pre")).toContainText('"charger_code": "DEMO-6"');
  await shot(page, "pos");

  // The POS takes the money and calls POST /api/pos/mark-paid.
  await six
    .getByRole("button", { name: /POS: Charger 6 paid .* \(cash\)/ })
    .click();
  await expect(pos.getByTestId("pos-result")).toContainText('"status": "paid"');
  await expect(pos.getByTestId("pos-result")).toContainText('"method": "cash"');
  await expect(tile(page, "Charger 6", "Paid")).toBeVisible();
  await expect(six).toHaveCount(0);

  // Same receipt as a console payment, and the demo shows the email instead of sending it.
  await tile(page, "Charger 6", "Paid").click();
  await page
    .getByRole("region", { name: "Charger 6" })
    .getByRole("link", { name: "Print receipt" })
    .click();
  await expect(page.getByTestId("store-receipt")).toContainText(
    "Paid in store (cash)",
  );
  await expect(page.getByTestId("store-receipt")).toContainText(
    "POS ref SIM-2001",
  );
  const email = page.getByRole("region", { name: "Email receipt" });
  await email
    .getByLabel("Driver's email (used once, not stored)")
    .fill("driver@example.com");
  await email.getByRole("button", { name: "Email receipt" }).click();
  const preview = page.getByTestId("email-preview");
  await expect(preview).toContainText("Demo: nothing was sent.");
  await expect(preview).toContainText("Charger 6");
  await expect(
    email.getByLabel("Driver's email (used once, not stored)"),
  ).toHaveValue("");
  expect(external).toEqual([]);
});
