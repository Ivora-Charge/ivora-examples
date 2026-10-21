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
  await expect(
    page.getByRole("region", { name: "Live summary" }),
  ).toContainText("Faulted");
  // The map draws the sample sites without tiles; the list works on its own.
  await expect(page.locator(".live-map .map-marker").first()).toBeAttached();
  await expect(page.getByText(/no map tiles are loaded/)).toBeVisible();
  const harbour = page.getByRole("list", {
    name: "Chargers at Sample Site: Harbour Car Park",
  });
  await expect(harbour).toContainText("DEMO-HARBOUR-02");
  await expect(harbour.getByText("Faulted").first()).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Sessions running" }),
  ).toContainText("DEMO-HARBOUR-02");
  await expect(page.getByRole("list", { name: "Open faults" })).toContainText(
    "GroundFailure",
  );
  expect(external).toEqual([]);
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
