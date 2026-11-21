import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Demo mode, network mode part 2: the two sample hosts' payouts, network fees and
// monthly statements, and the block on driver card payment at a host's site whose
// payouts are not ready. Each test gets a fresh browser context (fresh demo cookies).
// Nothing is sent to Stripe or anywhere else.

const HOST_A = "Sample Host A: Harbour Shops";

test("demo: a host's monthly statement with totals, CSV and print", async ({
  page,
}) => {
  await page.goto("/reports/statements?month=2026-10");
  await expect(
    page.getByRole("heading", { level: 1, name: `Statement: ${HOST_A}` }),
  ).toBeVisible();
  await expect(page.getByText("Demo: a sample statement")).toBeVisible();
  await expect(
    page.getByText(/\$0\.05 per kWh; \$15\.00 a month per charger/),
  ).toBeVisible();
  await expect(page.getByText("Monthly charger fee:")).toBeVisible();
  const totals = page.getByRole("table").first();
  await expect(
    totals.getByRole("columnheader", { name: "Host share" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Print" })).toBeVisible();
  const csv = await page.request.get(
    "/reports/statements/export?month=2026-10&host=demo-host-a",
  );
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  const body = await csv.text();
  expect(body.split("\r\n")[0]).toMatch(/^line,session_ref,/);
  expect(body).toContain("\r\ntotal,");
  expect(body).toContain("\r\nmonthly_charger_fee,");
  // Another host by its picker; an unknown one is not found.
  await page
    .getByLabel("Host", { exact: true })
    .selectOption({ label: "Sample Host B: Riverside Hotel" });
  await page.getByRole("button", { name: "Show" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: /Sample Host B/ }),
  ).toBeVisible();
  const missing = await page.request.get(
    "/reports/statements/export?month=2026-10&host=demo-host-zzz",
  );
  expect(missing.status()).toBe(404);
  const a11y = await new AxeBuilder({ page }).analyze();
  expect(a11y.violations).toEqual([]);
});

test("demo: card payment is off at a host's site until its payouts are ready", async ({
  page,
}) => {
  await page.goto("/hosts");
  const item = page
    .getByRole("list", { name: "Hosts" })
    .getByRole("listitem")
    .filter({ hasText: HOST_A });
  await item.locator("summary").click();
  await expect(item.getByText("Network fee", { exact: true })).toBeVisible();
  await item.getByLabel("Demo: simulate payouts").selectOption("action_needed");
  await item.getByRole("button", { name: "Simulate" }).click();
  await expect(
    item.getByText(/driver card payments at its sites are off/),
  ).toBeVisible();

  // DEMO-HARBOUR-01 is at Harbour Car Park, one of host A's sites.
  await page.goto("/chargers/station-9101?tab=stickers");
  await page.getByRole("button", { name: "Create sticker codes" }).click();
  const url = (await page
    .getByRole("article")
    .first()
    .locator(".sticker-url")
    .textContent())!;
  await page.goto(new URL(url).pathname);
  await expect(
    page.getByText(/Card payment isn't set up at this site yet/).first(),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Pay and charge" })
      .getByRole("button", { name: "Not available right now" }),
  ).toBeDisabled();
});

test("demo: a new network fee applies from now on", async ({ page }) => {
  await page.goto("/hosts");
  const item = page
    .getByRole("list", { name: "Hosts" })
    .getByRole("listitem")
    .filter({ hasText: HOST_A });
  await item.locator("summary").click();
  await item.getByLabel("A percentage of each session's amount").check();
  await item.getByLabel("Percentage (0 to 100)").fill("12.5");
  await item.getByRole("button", { name: "Save network fee" }).click();
  await expect(
    item
      .getByText(
        "Network fee saved. It applies to sessions started from now on.",
      )
      .first(),
  ).toBeVisible();
  await page.reload();
  const again = page
    .getByRole("list", { name: "Hosts" })
    .getByRole("listitem")
    .filter({ hasText: HOST_A });
  await again.locator("summary").click();
  await expect(
    again.getByText(/12\.5% of each session's amount/).first(),
  ).toBeVisible();
  await expect(again.getByText(/Earlier fees/)).toBeVisible();
});
