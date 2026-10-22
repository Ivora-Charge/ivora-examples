import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Demo mode with the optional Cards module on (FLEET_MODULE=1 in playwright.config.ts):
// five sample cards, sample RFID sessions from the demo history, and the visitor's own
// cards and changes in a cookie, so each test starts from the samples. Nothing is sent
// to Ivora.

async function openCards(page: Page, isMobile: boolean) {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  if (isMobile) await nav.getByRole("button", { name: "Menu" }).click();
  await nav.getByRole("link", { name: /^Cards/ }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: /Cards/ }),
  ).toBeVisible();
}

const status = (page: Page, text: string | RegExp) =>
  page.locator("main").getByRole("status").filter({ hasText: text });

test("demo: add a card for a vehicle, block it, make it active again and set an expiry date", async ({
  page,
  isMobile,
}) => {
  await openCards(page, isMobile);
  const cards = page.getByRole("table", { name: "Cards" });
  await expect(cards).toContainText("****0001");
  await expect(cards).toContainText("Driver: Sample Driver Ada");
  await expect(
    cards.getByRole("row").filter({ hasText: "****0005" }),
  ).toContainText("Blocked");
  await expect(
    page.getByRole("list", { name: "Private chargers" }),
  ).toContainText("DEMO-MARKET-01");
  await expect(
    page.getByRole("link", { name: "the fleet-depot template" }),
  ).toBeVisible();

  await page.getByLabel("Card value").fill("DEMO-E2E-0101");
  await page.getByRole("combobox", { name: "Holder" }).selectOption("vehicle");
  await page.getByLabel("Driver or vehicle name").fill("Sample Van 9");
  await page.getByRole("button", { name: "Add card" }).click();
  await expect(
    status(page, "Card ****0101 added for Sample Van 9"),
  ).toContainText("Demo: nothing was sent to Ivora.");
  await expect(cards).toContainText("Vehicle: Sample Van 9");
  // The form starts again empty for the next card.
  await expect(page.getByLabel("Card value")).toHaveValue("");

  // The same value again, in another case, is refused: Ivora matches cards that way.
  await page.getByLabel("Card value").fill("demo-e2e-0101");
  await page.getByLabel("Driver or vehicle name").fill("Someone else");
  await page.getByRole("button", { name: "Add card" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText(
    "This card is already in your list",
  );

  await cards.getByRole("link", { name: "****0101" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Card ****0101" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Block card" }).click();
  await expect(status(page, "is blocked")).toBeVisible();
  const card = page.getByRole("region", { name: /Vehicle: Sample Van 9/ });
  await expect(card).toContainText("Blocked");
  await page.getByRole("button", { name: "Make active again" }).click();
  await expect(status(page, "is active again")).toBeVisible();
  await expect(card).toContainText("Active");

  await page.getByLabel("Valid until").fill("2099-12-31");
  await page.getByRole("button", { name: "Set expiry date" }).click();
  await expect(status(page, "works until the end of 2099-12-31")).toBeVisible();
  await expect(card).toContainText("End of 2099-12-31");
  await page.getByRole("button", { name: "Remove expiry date" }).click();
  await expect(status(page, "no longer has an expiry date")).toBeVisible();
  await expect(card).toContainText("No expiry date");

  await page.getByRole("combobox", { name: "Holder" }).selectOption("driver");
  await page.getByLabel("Driver or vehicle name").fill("Sample Driver Zoe");
  await page.getByRole("button", { name: "Save holder" }).click();
  await expect(
    status(page, 'labelled "Driver: Sample Driver Zoe"'),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Driver: Sample Driver Zoe" }),
  ).toBeVisible();
});

test("demo: each sample card shows its sessions and energy", async ({
  page,
  isMobile,
}) => {
  await openCards(page, isMobile);
  await page
    .getByRole("combobox", { name: "Sessions and energy" })
    .selectOption("365");
  await page.getByRole("button", { name: "Show cards" }).click();
  const row = page
    .getByRole("table", { name: "Cards" })
    .getByRole("row")
    .filter({ hasText: "****0001" });
  await expect(row).toContainText("kWh");
  await row.getByRole("link", { name: "****0001" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Card ****0001" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Sessions and energy" })
    .selectOption("365");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(
    page.getByRole("region", { name: /Figures: last 12 months/ }),
  ).toContainText("Sessions");
  const sessions = page.getByRole("table", { name: "Sessions with this card" });
  await expect(sessions).toContainText("DEMO-");
  await expect(sessions).toContainText("kWh");
});

test("demo: check a CSV file, then import it", async ({ page, isMobile }) => {
  await openCards(page, isMobile);
  await page
    .getByLabel("Or paste the lines")
    .fill(
      [
        "card,holder,name",
        "DEMO-E2E-0201,driver,Sample Driver Uma",
        "DEMO-E2E-0202,vehicle,Sample Van 10",
        "has space,driver,Nope",
        "DEMO-RFID-0002,driver,Sample Driver Ben B",
      ].join("\n"),
    );
  await page.getByRole("button", { name: "Check file" }).click();
  await expect(
    status(page, "Check: 2 new, 1 relabelled, 0 unchanged, 1 refused"),
  ).toContainText("Nothing has been sent yet.");
  const check = page.getByRole("table", { name: "Import check" });
  await expect(check).toContainText("without spaces");
  await expect(page.getByRole("table", { name: "Cards" })).not.toContainText(
    "Sample Driver Uma",
  );

  await page.getByRole("button", { name: "Import 3 cards" }).click();
  await expect(
    status(page, "Imported: 2 added, 1 relabelled, 1 refused."),
  ).toContainText("Demo: nothing was sent to Ivora.");
  const cards = page.getByRole("table", { name: "Cards" });
  await expect(cards).toContainText("Driver: Sample Driver Uma");
  await expect(cards).toContainText("Vehicle: Sample Van 10");
  await expect(cards).toContainText("Driver: Sample Driver Ben B");

  // A file works too.
  await page.getByLabel("CSV file").setInputFiles({
    name: "cards.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("DEMO-E2E-0203,vehicle,Sample Van 11\n"),
  });
  await page.getByRole("button", { name: "Check file" }).click();
  await expect(status(page, "Check: 1 new")).toBeVisible();
  await page.getByRole("button", { name: "Import 1 card" }).click();
  await expect(cards).toContainText("Vehicle: Sample Van 11");

  await page.getByRole("button", { name: "Demo: reset cards" }).click();
  await expect(cards).not.toContainText("Sample Van 11");
});

test("demo: the Cards pages pass axe in light and dark and fit a phone", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "sets its own phone viewport");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/cards", "/cards/9601"])
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(path);
      if (process.env.SCREENSHOT && path === "/cards")
        await page.screenshot({
          path: `docs/screens/cards-phone-${scheme}.png`,
        });
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(
        results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`),
        `${path} ${scheme}`,
      ).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(0);
    }
});

test("demo: screenshots of Cards for the README (SCREENSHOT=1, desktop)", async ({
  page,
  isMobile,
}) => {
  test.skip(!process.env.SCREENSHOT || isMobile, "only when asked, on desktop");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/cards?days=90");
    await page.screenshot({
      path: `docs/screens/cards-desktop-${scheme}.png`,
      fullPage: true,
      clip: { x: 0, y: 0, width: 1280, height: 1100 },
    });
  }
});
