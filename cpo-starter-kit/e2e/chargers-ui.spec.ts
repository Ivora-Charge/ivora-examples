import { expect, test, type Locator, type Page } from "@playwright/test";

// The Chargers list (search, filter, sort, phone cards) and the charger page (tabs,
// local times, the danger zone, tap targets). Demo mode: sample chargers only.

const TAP = 44;

/** Every control matched must be at least 44 px tall, as the README promises. */
async function expectTall(controls: Locator, what: string) {
  const n = await controls.count();
  expect(n, `${what}: some to measure`).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const el = controls.nth(i);
    if (!(await el.isVisible())) continue;
    const box = (await el.boundingBox())!;
    const name = (await el.textContent())?.trim();
    expect(
      Math.round(box.height),
      `${what} "${name}" is ${box.height} px tall`,
    ).toBeGreaterThanOrEqual(TAP);
  }
}

async function rowNames(page: Page) {
  return page
    .getByRole("table", { name: "Chargers" })
    .locator("tbody tr td:first-child a")
    .allTextContents();
}

test("list: search, filter and sort the chargers", async ({ page }) => {
  await page.goto("/chargers");
  const table = page.getByRole("table", { name: "Chargers" });
  await expect(table).toContainText("DEMO-HARBOUR-01");
  const total = (await rowNames(page)).length;
  expect(total).toBeGreaterThan(2);

  await page.getByRole("searchbox", { name: "Search Chargers" }).fill("market");
  await expect.poll(() => rowNames(page)).toEqual(["DEMO-MARKET-01"]);
  await expect(page.getByText(`Showing 1 of ${total}`)).toBeVisible();
  await page.getByRole("searchbox", { name: "Search Chargers" }).fill("");

  await page.getByLabel("Filter by status").selectOption("Offline");
  await expect.poll(() => rowNames(page)).toEqual(["DEMO-MARKET-01"]);
  await page.getByLabel("Filter by status").selectOption("");
  await page
    .getByLabel("Filter by site")
    .selectOption("Sample Site: Harbour Car Park");
  await expect
    .poll(() => rowNames(page))
    .toEqual(expect.arrayContaining(["DEMO-HARBOUR-01", "DEMO-HARBOUR-02"]));
  expect(await rowNames(page)).not.toContain("DEMO-MARKET-01");
  await page.getByLabel("Filter by site").selectOption("");

  const header = table.getByRole("columnheader", { name: "Charger" });
  const sort = header.getByRole("button", { name: "Charger" });
  // Hidden header on a phone: sort by keyboard there, as a screen reader would.
  await sort.focus();
  await page.keyboard.press("Enter");
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  const up = await rowNames(page);
  expect(up).toEqual([...up].sort((a, b) => a.localeCompare(b)));
  await page.keyboard.press("Enter");
  await expect(header).toHaveAttribute("aria-sort", "descending");
  expect(await rowNames(page)).toEqual([...up].reverse());
});

test("list: rows stack into cards at 390 px with no sideways scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/chargers");
  const row = page.getByRole("table", { name: "Chargers" }).locator("tbody tr");
  await expect(row.first()).toBeVisible();
  expect(await row.first().evaluate((el) => getComputedStyle(el).display)).toBe(
    "block",
  );
  // Each value carries its column label.
  await expect(row.first().locator('td[data-label="Status"]')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
});

test("list and charger page: controls are at least 44 px tall", async ({
  page,
}) => {
  await page.goto("/chargers");
  const table = page.getByRole("table", { name: "Chargers" });
  await expect(table).toBeVisible();
  // Sort buttons (in the hidden header on a phone, so only at desktop widths).
  await expectTall(table.locator("thead button"), "Sort button");
  await expectTall(table.locator("tbody a"), "Charger link");
  await expectTall(
    page.locator("main .table-toolbar").locator("input, select, button"),
    "Toolbar control",
  );

  await page.goto("/chargers/station-9101");
  await expectTall(page.getByRole("tab"), "Tab");
  await expectTall(page.locator("main .button"), "Button");
  for (const tab of ["Configuration", "QR stickers", "Test"]) {
    await page.getByRole("tab", { name: tab }).click();
    const panel = page.getByRole("tabpanel", { name: tab });
    await expectTall(
      panel.locator(
        "button, .button, select, input:not([type=checkbox]), summary",
      ),
      `${tab} control`,
    );
  }
});

test("charger page: overview first, tabs by arrow keys and ?tab=", async ({
  page,
}) => {
  await page.goto("/chargers/station-9101");
  // Overview leads with the connectors; configuration is not on it.
  const overview = page.getByRole("tabpanel", { name: "Overview" });
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    overview.getByRole("list", { name: "Connectors" }).getByRole("listitem"),
  ).not.toHaveCount(0);
  await expect(overview).not.toContainText("OCPP connection URL");
  await expect(overview).not.toContainText("Password");

  // Arrow keys move between tabs; Home and End jump to the ends.
  await page.getByRole("tab", { name: "Overview" }).focus();
  await page.keyboard.press("ArrowRight");
  const config = page.getByRole("tab", { name: "Configuration" });
  await expect(config).toBeFocused();
  await expect(config).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Test" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Overview" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Test" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Home");
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // ?tab= opens a tab; Configuration has the read-only Connection card.
  await page.goto("/chargers/station-9101?tab=configuration");
  await expect(config).toHaveAttribute("aria-selected", "true");
  const conn = page.getByRole("region", { name: "Connection" });
  await expect(conn).toContainText("DEMO-HARBOUR-01");
  await expect(conn).toContainText("wss://ocpp.demo.example/DEMO-HARBOUR-01");
  await expect(conn).toContainText("Password");
  await expect(conn).toContainText("Protocol");
  await page.goto("/chargers/station-9101?tab=nonsense");
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("charger page: times in the site's zone, with UTC beside them", async ({
  page,
}) => {
  // DEMO-MARKET-01 is offline at a New York site; its last message is fixed.
  await page.goto("/chargers/station-9103");
  const overview = page.getByRole("tabpanel", { name: "Overview" });
  await expect(overview).toContainText("2025-12-31 19:00 America/New_York");
  await expect(overview).toContainText("2026-01-01 00:00 UTC");
  const strip = page.getByLabel("Charger at a glance");
  await expect(strip).toContainText("2025-12-31 19:00");
  await expect(strip).toContainText(
    /America\/New_York · \d+ (days|h|min|s) ago/,
  );

  await page.goto("/chargers");
  const row = page
    .getByRole("table", { name: "Chargers" })
    .getByRole("row")
    .filter({ hasText: "DEMO-MARKET-01" });
  await expect(row).toContainText("2025-12-31 19:00 America/New_York");
  await expect(row).toContainText("2026-01-01 00:00 UTC");
});

test("charger page: the test tab explains briefly; the rest is behind a control", async ({
  page,
}) => {
  await page.goto("/chargers/station-9101?tab=test");
  const remote = page.getByRole("region", {
    name: /Remote start and stop test/,
  });
  await expect(remote).toContainText("to prove the charger takes remote");
  const long = remote.getByText(/only ever stops its own session/);
  await expect(long).toBeHidden();
  await remote.getByText("How this test works").click();
  await expect(long).toBeVisible();
  // The warning and the confirmation are unchanged.
  await expect(
    remote.getByText("This starts the charger.", { exact: true }),
  ).toBeVisible();
  await expect(
    remote.getByLabel("I understand this starts the charger."),
  ).toBeVisible();
});

test("charger page: removal sits apart, under the tabs, behind a confirmation", async ({
  page,
}) => {
  await page.goto("/chargers/station-9101");
  const zone = page.getByRole("region", { name: "Remove" });
  await expect(zone).toBeVisible();
  // Outside every tab panel, so it is there whichever tab is open.
  expect(await zone.evaluate((el) => !el.closest('[role="tabpanel"]'))).toBe(
    true,
  );
  for (const tab of ["Configuration", "Test"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(zone).toBeVisible();
  }
  // After the tabs in reading order.
  expect(
    await zone.evaluate((el) => {
      const tabs = document.querySelector('[role="tablist"]')!;
      return !!(
        tabs.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING
      );
    }),
  ).toBe(true);
  const button = zone.getByRole("button", { name: "Remove charger" });
  await button.click();
  // Without the confirmation the browser refuses to send it.
  expect(
    await zone
      .getByLabel(/I understand, remove/)
      .evaluate((el) => (el as HTMLInputElement).validity.valid),
  ).toBe(false);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "DEMO-HARBOUR-01",
  );
});
