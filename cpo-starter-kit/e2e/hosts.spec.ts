import { expect, test, type Page } from "@playwright/test";

// Demo mode, network mode: the sample network has two fictional hosts. Host A (sites
// Harbour Car Park and Market Street) may restart, unlock, start and stop; host B
// (Waterfront and Riverside Hotel) has every switch off. Each test gets a fresh
// browser context, so fresh sample hosts (they live in the visitor's cookie).

const HOST_A = "Sample Host A: Harbour Shops";
const HOST_B = "Sample Host B: Riverside Hotel";

async function viewAs(page: Page, host: string, email: string) {
  await page.goto("/hosts");
  const item = page
    .getByRole("list", { name: "Hosts" })
    .getByRole("listitem")
    .filter({ hasText: host });
  await item.locator("summary").click();
  await item.getByRole("button", { name: `View as ${email}` }).click();
  await expect(
    page.getByText(`viewing the app as a user of ${host}`),
  ).toBeVisible();
}

async function navLinks(page: Page, isMobile: boolean) {
  const nav = page.getByRole("navigation", { name: "Main" });
  if (isMobile) await nav.getByRole("button", { name: "Menu" }).click();
  const names = await nav.getByRole("link").allTextContents();
  if (isMobile) await nav.getByRole("button", { name: "Menu" }).click();
  return names.map((n) => n.trim());
}

/** No sideways scroll: the page is no wider than the window. */
async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("demo: the Hosts page lists the two sample hosts and every site's host", async ({
  page,
}) => {
  await page.goto("/hosts");
  await expect(
    page.getByRole("heading", { level: 1, name: "Hosts" }),
  ).toBeVisible();
  const hosts = page.getByRole("list", { name: "Hosts" });
  await expect(
    hosts.locator("summary .name", { hasText: HOST_A }),
  ).toBeVisible();
  await expect(
    hosts.locator("summary .name", { hasText: HOST_B }),
  ).toBeVisible();
  await expect(hosts.getByText("View only: every switch is off")).toBeVisible();
  const sites = page.getByRole("list", { name: "Sites and their hosts" });
  await expect(
    sites.getByRole("combobox", {
      name: "Host of Sample Site: Riverside Hotel",
    }),
  ).toHaveValue("demo-host-b");
});

test("demo: an owner adds a host with every switch off and gives it a site", async ({
  page,
}) => {
  await page.goto("/hosts");
  const add = page.locator("section", {
    has: page.getByRole("heading", { name: "Add a host" }),
  });
  await add.getByLabel("Company name").fill("Sample Host C: Parking");
  for (const box of await add.getByRole("checkbox").all())
    await expect(box).not.toBeChecked();
  await add.getByRole("button", { name: "Add host" }).click();
  await expect(add.getByText("Saved")).toBeVisible();
  const hosts = page.getByRole("list", { name: "Hosts" });
  await expect(
    hosts.locator("summary .name", { hasText: "Sample Host C: Parking" }),
  ).toBeVisible();
  const site = page
    .getByRole("list", { name: "Sites and their hosts" })
    .getByRole("listitem")
    .filter({ hasText: "Sample Site: Market Street" });
  await site
    .getByRole("combobox")
    .selectOption({ label: "Sample Host C: Parking" });
  await site.getByRole("button", { name: /Save the host of/ }).click();
  await expect(site.getByText("Saved")).toBeVisible();
});

test("demo: a host user with every switch off sees only their sites and can change nothing", async ({
  page,
  isMobile,
}) => {
  await viewAs(page, HOST_B, "sample-host-b@example.com");
  // The Overview counts only the host's sites, without the project-wide chart.
  await expect(page.getByText(`${HOST_B}: your sites now.`)).toBeVisible();
  await expect(
    page.locator(".stat", { hasText: "Sites" }).locator(".stat-value"),
  ).toHaveText("2");
  await expect(page.getByText("Energy, last 30 days")).toHaveCount(0);
  expect(await navLinks(page, isMobile)).toEqual([
    "Overview",
    "Chargers",
    "Live",
    "Reports",
  ]);
  await page.goto("/chargers");
  const table = page.getByRole("table", { name: "Chargers" });
  await expect(table.getByText("DEMO-RIVERSIDE-01").first()).toBeVisible();
  await expect(table.getByText("DEMO-WATERFRONT-01").first()).toBeVisible();
  await expect(page.getByText("DEMO-HARBOUR-01")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Add charger" })).toHaveCount(0);
  await page.goto("/live/stations/9105");
  await expect(
    page.getByRole("heading", { level: 1, name: "DEMO-RIVERSIDE-01" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Reset/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Unlock/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /start/i })).toHaveCount(0);
});

test("demo: deep links to another host's objects, and operator-only pages, answer 404", async ({
  page,
}) => {
  await viewAs(page, HOST_B, "sample-host-b@example.com");
  for (const path of [
    "/live/stations/9101",
    "/chargers/station-9101",
    "/chargers/station-9101/stickers",
    "/reports?station=9101",
    "/pricing",
    "/pricing/new",
    "/team",
    "/hosts",
    "/settings",
    "/onboarding",
    "/cards",
  ]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
  }
  const csv = await page.request.get("/reports/export?station=9101");
  expect(csv.status()).toBe(404);
  // Their own charger is there.
  const own = await page.goto("/live/stations/9104");
  expect(own?.status()).toBe(200);
});

test("demo: a host user with the restart switch can reset their own charger only", async ({
  page,
  isMobile,
}) => {
  await viewAs(page, HOST_A, "sample-host-a@example.com");
  await page.goto("/live/stations/9101");
  await expect(
    page.getByRole("heading", { name: "Reset", exact: true }),
  ).toBeVisible();
  await page.goto("/live");
  await expect(page.getByText("DEMO-WATERFRONT-01")).toHaveCount(0);
  await expect(page.getByText("DEMO-HARBOUR-01").first()).toBeVisible();
  // Back to the demo owner, who sees every site again. On a phone the button is
  // in the menu.
  if (isMobile)
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Menu" })
      .click();
  await page.getByRole("button", { name: "Back to the demo owner" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Hosts" }),
  ).toBeVisible();
  await page.goto("/chargers");
  await expect(page.getByText("DEMO-WATERFRONT-01").first()).toBeVisible();
});

test("demo: operator staff filter Chargers, Live and Reports by host", async ({
  page,
}) => {
  await page.goto("/chargers?host=demo-host-b");
  await expect(page.getByText(`Showing ${HOST_B}.`)).toBeVisible();
  await expect(page.getByText("DEMO-HARBOUR-01")).toHaveCount(0);
  await expect(page.getByText("DEMO-RIVERSIDE-01").first()).toBeVisible();
  await page.goto("/live?host=own");
  await expect(page.getByText("Showing your own sites.")).toBeVisible();
  await page.goto("/reports?host=demo-host-a");
  await expect(page.getByLabel("Host")).toHaveValue("demo-host-a");
  await expect(
    page.getByText("Ivora's period figures cover your whole network"),
  ).toBeVisible();
});

test("network mode screens fit 390, 768 and 1440 wide, with 44 px controls", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "sets its own window sizes");
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/hosts");
    await expectNoSidewaysScroll(page);
    for (const control of await page
      .locator(
        "main button:visible, main select:visible, main .host summary:visible",
      )
      .all()) {
      const box = await control.boundingBox();
      if (box) expect(box.height, `${width}px`).toBeGreaterThanOrEqual(44);
    }
  }
  await viewAs(page, HOST_A, "sample-host-a@example.com");
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/", "/chargers", "/live", "/reports"]) {
      await page.goto(path);
      await expectNoSidewaysScroll(page);
    }
  }
});
