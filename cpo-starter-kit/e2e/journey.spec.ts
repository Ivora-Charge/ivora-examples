import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// The whole kit in one go, the way a new operator meets it: onboarding, a first
// charger, a first price, a driver paying at that charger, Live, Reports with the
// CSV export, and inviting a colleague. One browser context, so every step sees what
// the one before it did (the demo keeps the visitor's state in cookies). Runs on
// desktop and a phone, with the Cards module on and off (see playwright.config.ts).
// Demo mode: nothing is sent to Ivora, Stripe, a charger, an email provider or any
// other host, and the test checks that.

const CHARGER = "DEMO-JOURNEY-01";

async function open(page: Page, isMobile: boolean, name: string) {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  if (isMobile) await nav.getByRole("button", { name: "Menu" }).click();
  await nav.getByRole("link", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

test("demo journey: onboarding to a first charger and price, a paid session, Live, Reports and the team", async ({
  page,
  isMobile,
}) => {
  test.setTimeout(240_000);
  const fleet = test.info().project.metadata.fleet as boolean;
  const external: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("http://localhost")) external.push(r.url());
  });

  // The menu has Cards only with the module on.
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  if (isMobile) await nav.getByRole("button", { name: "Menu" }).click();
  await expect(nav.getByRole("link", { name: /^Cards/ })).toHaveCount(
    fleet ? 1 : 0,
  );

  await test.step("onboarding: company, brand and Stripe", async () => {
    await open(page, isMobile, "Onboarding");
    await page.getByLabel("Company name").fill("Sample Journey Charging");
    await page.getByLabel("Support email").fill("help@example.com");
    await page.getByLabel("Time zone").selectOption("America/New_York");
    await page.getByLabel("Currency").selectOption("USD");
    await page.getByRole("button", { name: "Save company details" }).click();
    await expect(page.getByText(/Company details saved/)).toBeVisible();

    await page.getByRole("link", { name: "Next: Brand" }).click();
    await page.getByLabel("Brand colour").fill("#1d3fa8");
    await page.getByRole("button", { name: "Save brand" }).click();
    await expect(page.getByText(/Brand saved/)).toBeVisible();

    await page.getByRole("link", { name: "Next: Payments" }).click();
    const payments = page.getByRole("region", { name: /Card payments/ });
    await payments
      .getByLabel("Demo: simulate a Stripe status")
      .selectOption("ready");
    await payments.getByRole("button", { name: "Simulate" }).click();
    await expect(payments).toContainText("Card payments are on");
  });

  await test.step("first charger: add it, it connects, stickers", async () => {
    await open(page, isMobile, "Chargers");
    await page.getByLabel("Connection name (charge point ID)").fill(CHARGER);
    await page.getByLabel("Connectors").selectOption("2");
    await page.getByLabel("Site").selectOption("new");
    await page.getByLabel("Site name").fill("Sample Site: Journey Lot");
    await page.getByRole("button", { name: "Add charger" }).click();
    await expect(page.getByText(/is registered/)).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Password" })).toHaveValue(
      /^[A-Za-z0-9]{24}$/,
    );
    await page
      .getByRole("link", { name: "Open the charger to test it" })
      .click();
    const conn = page.getByRole("region", { name: /Connection test/ });
    await expect(async () => {
      await conn
        .getByRole("button", { name: /Run (connection test|again)/ })
        .click();
      await expect(conn.getByText("Connection test passed.")).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 20_000 });
  });

  await test.step("first price: a tariff on the new charger", async () => {
    await open(page, isMobile, "Pricing");
    await page.getByRole("link", { name: "New tariff" }).click();
    await page.getByLabel("Tariff name").fill("Journey standard");
    await page.getByLabel("Price per kWh (USD)", { exact: true }).fill("0.30");
    await page.getByRole("button", { name: "Preview price" }).click();
    await expect(page.getByTestId("quote-total")).toHaveText(/^\$\d+\.\d\d$/);
    await page.getByRole("button", { name: "Create tariff" }).click();
    await expect(page.getByText(/Tariff created in Ivora/)).toBeVisible();

    await page.goto("/pricing");
    const mine = page
      .getByRole("list", { name: "Chargers and their tariffs" })
      .getByRole("listitem")
      .filter({ hasText: CHARGER })
      .first();
    await mine.getByText("Change").click();
    await mine
      .getByLabel(`Tariff for ${CHARGER}`)
      .selectOption({ label: "Journey standard" });
    await mine
      .getByRole("button", { name: `Save prices for ${CHARGER}` })
      .click();
    await expect(mine.getByText(`Prices saved for ${CHARGER}.`)).toBeVisible();

    // Every step of the setup checklist is done.
    await page.goto("/");
    await expect(page.getByText("5 of 5 done")).toBeVisible();
  });

  let sticker = "";
  await test.step("driver checkout: scan, pay with the demo card, charge", async () => {
    await open(page, isMobile, "Chargers");
    await page
      .getByRole("list", { name: "Chargers" })
      .getByRole("link", { name: CHARGER })
      .click();
    await page.getByRole("button", { name: "Create sticker codes" }).click();
    const url = (await page
      .getByRole("article")
      .first()
      .locator(".sticker-url")
      .textContent())!;
    sticker = new URL(url).pathname;
    await page.goto(sticker);
    await expect(
      page.getByRole("heading", { level: 1, name: /connector 1/ }),
    ).toBeVisible();
    await expect(page.getByText(/\$0\.30 per kWh/)).toBeVisible();
    await page
      .getByRole("button", { name: /Pay and charge with a demo card/ })
      .click();
    await expect(page).toHaveURL(/\/demo\/checkout\/pay_demo_/);
    await page.getByRole("button", { name: /Pay with demo card/ }).click();
    await expect(page).toHaveURL(sticker);
    const session = page.getByRole("region", { name: "Your session" });
    await expect(session.locator("strong").first()).toHaveText("Charging", {
      timeout: 15_000,
    });
  });

  await test.step("live: the driver's session, a staff start and stop", async () => {
    await open(page, isMobile, "Live");
    await expect(
      page.getByRole("list", { name: "Sessions running" }),
    ).toContainText(CHARGER);
    await page
      .getByRole("list", { name: "Sessions running" })
      .getByRole("link", { name: new RegExp(CHARGER) })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: CHARGER }),
    ).toBeVisible();
    // Remote start on the free connector, never next to the driver's.
    const second = page
      .getByRole("region", { name: "Connectors" })
      .getByRole("listitem")
      .filter({ hasText: "Connector 2" });
    await second.getByText("Remote start…").click();
    await second
      .getByLabel(/^I understand this switches on connector 2/)
      .check();
    await second.getByRole("button", { name: "Start connector 2" }).click();
    await expect(
      page.getByText(/Remote start accepted by the charger/),
    ).toBeVisible();
    await expect(page.getByRole("list", { name: "Sessions" })).toContainText(
      "staff session",
    );
  });

  await test.step("the driver stops and gets a receipt", async () => {
    await page.goto(sticker);
    const session = page.getByRole("region", { name: "Your session" });
    await session.getByRole("button", { name: "Stop charging" }).click();
    await expect(session.locator("strong").first()).toHaveText("Finished");
    await expect(session.getByTestId("receipt-charged")).toHaveText(
      /^\$\d+\.\d\d$/,
    );
    await expect(session).toContainText("no card was charged");
  });

  await test.step("reports: the session, then the CSV", async () => {
    await open(page, isMobile, "Reports");
    await page.getByLabel("Period", { exact: true }).selectOption("24h");
    await page
      .getByLabel("Charger (your sessions)")
      .selectOption({ label: CHARGER });
    await page.getByRole("button", { name: "Show report" }).click();
    const yours = page.getByRole("region", {
      name: /^Your sessions \(this kit\)/,
    });
    await expect(yours.getByRole("table")).toContainText(CHARGER);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Download CSV" }).click(),
    ]);
    const lines = (await readFile((await download.path())!, "utf8"))
      .trimEnd()
      .split("\r\n");
    const header = lines[0].split(",");
    const rows = lines.slice(1).map((l) => l.split(","));
    const mine = rows.filter((r) => r[header.indexOf("station")] === CHARGER);
    expect(mine).toHaveLength(1);
    expect(mine[0][header.indexOf("session_type")]).toBe("paid");
    expect(mine[0][header.indexOf("currency")]).toBe("USD");
  });

  await test.step("team: invite a technician", async () => {
    await open(page, isMobile, "Team");
    await page
      .getByLabel("Email", { exact: true })
      .fill("journey-tech@example.com");
    await page.getByLabel("Role", { exact: true }).selectOption("technician");
    await page.getByRole("button", { name: "Send invite" }).click();
    await expect(page.getByText("Demo: no email was sent")).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Pending invites" }),
    ).toContainText("journey-tech@example.com");
  });

  await test.step("accessibility: the pages the journey ended on pass axe", async () => {
    for (const path of ["/", "/chargers", "/pricing", "/reports", "/team"]) {
      await page.goto(path);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(
        results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`),
        path,
      ).toEqual([]);
    }
  });

  // Offline all the way: no map tiles, Stripe, Ivora or anything else.
  expect(external).toEqual([]);
});
