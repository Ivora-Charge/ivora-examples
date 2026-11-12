import { expect, test, type Page } from "@playwright/test";

// Demo mode: signed in as the labelled demo owner, a fresh demo fleet per test (it
// lives in the browser's cookie). Commands are simulated by the demo client; nothing
// is sent to Ivora or a charger, and no map tiles are loaded.

async function openLive(page: Page, isMobile: boolean) {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  if (isMobile) await nav.getByRole("button", { name: "Menu" }).click();
  await nav.getByRole("link", { name: /^Live/ }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Live" }),
  ).toBeVisible();
}

test("demo: live map and list show status, faults and sessions", async ({
  page,
  isMobile,
}) => {
  // Demo mode is offline: the page must not ask any other host for anything.
  const external: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("http://localhost")) external.push(r.url());
  });
  await openLive(page, isMobile);
  await expect(page.getByText("Faulted").first()).toBeVisible();
  // The banner is a polite status, so a refresh with the same faults isn't re-read.
  await expect(
    page.locator(".fault-banner[role=status]").filter({ hasText: /attention/ }),
  ).toContainText(/need.* attention/);
  // The map draws the sample sites without tiles; the list works on its own.
  await expect(page.locator(".live-map .map-marker").first()).toBeAttached();
  await expect(page.getByText(/no map tiles are loaded/)).toBeVisible();
  const chargers = page.getByRole("table", { name: "Chargers" });
  const harbour = chargers
    .getByRole("row")
    .filter({ hasText: "DEMO-HARBOUR-02" });
  await expect(harbour.getByText("Faulted").first()).toBeVisible();
  // The status figures filter the table.
  await page.getByRole("link", { name: /^Faulted/ }).click();
  await expect(
    chargers.getByRole("row").filter({ hasText: "DEMO-HARBOUR-01" }),
  ).toHaveCount(0);
  await expect(harbour).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Sessions running" }),
  ).toContainText("DEMO-HARBOUR-02");
  await expect(page.getByRole("list", { name: "Open faults" })).toContainText(
    "GroundFailure",
  );
  expect(external).toEqual([]);
});

test("demo: a selected charger gets its remote actions, each behind a confirmation", async ({
  page,
  isMobile,
}) => {
  await openLive(page, isMobile);
  await page
    .getByRole("link", { name: "Remote actions for DEMO-HARBOUR-02" })
    .click();
  const panel = page.getByRole("region", { name: "DEMO-HARBOUR-02" });
  await expect(panel).toBeVisible();
  await panel.getByText("Reset…").click();
  const send = panel.getByRole("button", { name: "Reset the charger" });
  await send.click();
  // Nothing is sent until the confirmation is ticked.
  await expect(page.getByText(/Reset accepted/)).toHaveCount(0);
  // The driver's running session is named, and needs its own tick.
  await panel
    .getByLabel(/^End session \d+ on connector 1/)
    .last()
    .check();
  await panel.getByLabel("I understand this restarts DEMO-HARBOUR-02.").check();
  await send.click();
  await expect(page.getByText(/Reset accepted by the charger/)).toBeVisible();
});

test("demo: stop a driver's session only after naming it, then reset and unlock", async ({
  page,
  isMobile,
}) => {
  await openLive(page, isMobile);
  await page
    .getByRole("list", { name: "Sessions running" })
    .getByRole("link", { name: /DEMO-HARBOUR-02/ })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "DEMO-HARBOUR-02" }),
  ).toBeVisible();
  // Recent faults come from the charger's fault history.
  await expect(page.getByRole("list", { name: "Faults" })).toContainText(
    "GroundFailure",
  );

  // Stop: the confirmation names the session; the browser refuses to send it
  // until both boxes are ticked.
  const sessions = page.getByRole("region", { name: "Sessions" });
  await sessions.getByText("Stop…").click();
  const send = sessions.getByRole("button", { name: /^Stop session/ });
  await send.click();
  const endBox = sessions.getByLabel(/^End session \d+ on connector 1/);
  expect(
    await endBox.evaluate((el) => (el as HTMLInputElement).validity.valid),
  ).toBe(false);
  await endBox.check();
  await sessions
    .getByLabel("I understand the driver's charging stops now.")
    .check();
  await send.click();
  await expect(
    page.getByText(/Stop accepted by the charger \(Accepted\)/),
  ).toBeVisible();
  await expect(
    page.getByText(/Demo: simulated, nothing was sent/),
  ).toBeVisible();
  const commands = page.getByRole("list", { name: "Recent commands" });
  await expect(commands).toContainText(/Session \d+ ended\./);

  // Reset (soft): no session left to name. The charger restarts and its sample
  // fault clears once it is back.
  const reset = page.getByRole("region", { name: "Reset" });
  await reset.getByText("Reset…").click();
  await expect(reset.getByLabel(/^End session/)).toHaveCount(0);
  await reset.getByRole("radio", { name: /^Soft/ }).check();
  await reset.getByLabel("I understand this restarts DEMO-HARBOUR-02.").check();
  await reset.getByRole("button", { name: "Reset the charger" }).click();
  await expect(page.getByText(/Reset accepted by the charger/)).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(
      page.getByRole("list", { name: "Faults" }).getByText("Open"),
    ).toHaveCount(0, { timeout: 1_000 });
    await expect(
      page.getByRole("region", { name: /^Status/ }).getByText("Online"),
    ).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await expect(
    page.getByRole("list", { name: "Recent commands" }),
  ).toContainText("The charger is back online.");

  // Unlock a free connector: one confirmation, no session involved.
  const connectors = page.getByRole("region", { name: "Connectors" });
  const second = connectors.getByRole("listitem").filter({
    hasText: "Connector 2",
  });
  await second.getByText("Unlock…").click();
  await second.getByLabel("I understand this unlocks connector 2.").check();
  await second.getByRole("button", { name: "Unlock connector 2" }).click();
  await expect(
    page.getByText(/Unlock accepted by the charger \(Unlocked\)/),
  ).toBeVisible();
});

test("demo: remote start on a free connector, observed in the sessions", async ({
  page,
  isMobile,
}) => {
  await openLive(page, isMobile);
  await page.getByRole("link", { name: "DEMO-HARBOUR-01" }).first().click();
  const first = page
    .getByRole("region", { name: "Connectors" })
    .getByRole("listitem")
    .filter({ hasText: "Connector 1" });
  await first.getByText("Remote start…").click();
  await first.getByLabel(/^I understand this switches on connector 1/).check();
  await first.getByRole("button", { name: "Start connector 1" }).click();
  await expect(
    page.getByText(/Remote start accepted by the charger/),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Recent commands" }),
  ).toContainText(/Session \d+ started\./);
  await expect(page.getByRole("list", { name: "Sessions" })).toContainText(
    "Charging",
  );
  await expect(page.getByRole("list", { name: "Sessions" })).toContainText(
    "staff session",
  );
});

test("demo: map markers show status by shape and narrow the table to their site", async ({
  page,
  isMobile,
}) => {
  await openLive(page, isMobile);
  const map = page.locator(".live-map");
  const harbour = map.getByRole("button", {
    name: /^Sample Site: Harbour Car Park: Faulted/,
  });
  const market = map.getByRole("button", {
    name: /^Sample Site: Market Street: /,
  });
  // Faulted is a triangle; the others are a circle (online) or a square (offline).
  await expect(harbour.locator("svg path.shape")).toHaveCount(1);
  for (const [state, shape] of [
    ["online", "circle"],
    ["faulted", "path"],
    ["offline", "rect"],
  ])
    for (const m of await map.locator(`.map-marker.${state}`).all())
      await expect(m.locator(`svg ${shape}.shape`)).toHaveCount(1);

  const chargers = page.getByRole("table", { name: "Chargers" });
  await market.click();
  await expect(page).toHaveURL(/[?&]site=9002\b/);
  await expect(page.getByRole("note")).toContainText(
    "Showing chargers at Sample Site: Market Street",
  );
  await expect(chargers).toContainText("DEMO-MARKET-01");
  await expect(
    chargers.getByRole("row").filter({ hasText: "DEMO-HARBOUR" }),
  ).toHaveCount(0);

  // A marker is a button for the keyboard too.
  await harbour.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/[?&]site=9001\b/);
  await expect(chargers).toContainText("DEMO-HARBOUR-02");
  await expect(
    chargers.getByRole("row").filter({ hasText: "DEMO-MARKET-01" }),
  ).toHaveCount(0);

  await page.getByRole("link", { name: "Show all sites" }).click();
  await expect(chargers).toContainText("DEMO-MARKET-01");
  await expect(chargers).toContainText("DEMO-HARBOUR-02");
});

test("demo: at 1440 px the charger table fits beside the map, actions in view", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop layout");
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLive(page, false);
  const area = page.locator(".live-list .table-scroll-area");
  const { scrollWidth, clientWidth } = await area.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  const box = (await area.boundingBox())!;
  const action = page.getByRole("link", {
    name: "Remote actions for DEMO-HARBOUR-02",
  });
  await expect(action).toBeInViewport();
  const a = (await action.boundingBox())!;
  expect(a.x + a.width).toBeLessThanOrEqual(box.x + box.width);
  // The map sits beside the table, not below it.
  const map = (await page.locator(".live-map").boundingBox())!;
  expect(map.x).toBeGreaterThanOrEqual(box.x + box.width);
});
