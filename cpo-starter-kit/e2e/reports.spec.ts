import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

// Demo mode: six months of sample sessions and bills on the sample chargers, made up
// offline (lib/server/ivora/demo-history.ts). Nothing is sent to Ivora or Stripe.

async function openReports(page: Page, isMobile: boolean) {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  if (isMobile) await nav.getByRole("button", { name: "Menu" }).click();
  await nav.getByRole("link", { name: /^Reports/ }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Reports" }),
  ).toBeVisible();
}

const CSV_HEADER =
  "session_id,started_at_utc,ended_at_utc,time_zone,started_at_local,ended_at_local,duration_seconds,site,station_id,station,connector_id,connector_number,energy_wh,energy_kwh,session_type,status,stop_reason,bill_id,bill_status,amount_minor,currency";

test("demo: figures, series, top chargers and labelled sessions for the last 30 days", async ({
  page,
  isMobile,
}) => {
  await openReports(page, isMobile);
  await expect(
    page.getByRole("note").filter({ hasText: "Demo" }),
  ).toContainText("Nobody paid anything");
  const figures = page.getByRole("region", { name: "Figures for the period" });
  for (const label of [
    "Sessions",
    "Energy",
    "Success rate",
    "Average duration",
    "Billed revenue",
  ])
    await expect(figures.getByText(label, { exact: false })).toBeVisible();
  await expect(figures).toContainText("$");
  await expect(page.getByRole("heading", { name: "By day" })).toBeVisible();
  await expect(page.getByText("America/New_York").first()).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Top chargers by energy" }),
  ).toContainText("DEMO-");
  await expect(page.getByRole("list", { name: "Chargers now" })).toContainText(
    "Faulted",
  );

  const sessions = page.getByRole("region", { name: "Sessions" });
  await expect(sessions).toContainText("Driver revenue in this table");
  await expect(sessions).toContainText(
    "Staff/test and free sessions are labelled and never counted as driver revenue",
  );
  const table = sessions.getByRole("table");
  await expect(table.getByText("Staff/test").first()).toBeVisible();
  await expect(table.getByText("Free", { exact: true }).first()).toBeVisible();
  await expect(table.getByText("Driver (paid)").first()).toBeVisible();
  await expect(table.getByText(/UTC$/).first()).toBeVisible();

  const payouts = page.getByRole("region", { name: "Payouts" });
  await expect(payouts).toContainText("The kit holds no Stripe keys");
});

test("demo: filter by status and charger, then download the same sessions as CSV", async ({
  page,
  isMobile,
}) => {
  await openReports(page, isMobile);
  await page.getByLabel("Status (sessions)").selectOption("billed");
  await page.getByLabel("Charger (sessions)").selectOption({
    label: "DEMO-MARKET-01",
  });
  await page.getByRole("button", { name: "Show report" }).click();
  await expect(page).toHaveURL(/status=billed/);
  const table = page
    .getByRole("region", { name: "Sessions" })
    .getByRole("table");
  await expect(table.getByText("DEMO-MARKET-01").first()).toBeVisible();
  await expect(table.getByText("DEMO-HARBOUR-01")).toHaveCount(0);
  await expect(table.getByText("Staff/test")).toHaveCount(0);
  await expect(table.getByText("Final bill").first()).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(
    /^sessions-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/,
  );
  const csv = await readFile((await download.path())!, "utf8");
  const lines = csv.trimEnd().split("\r\n");
  expect(lines[0]).toBe(CSV_HEADER);
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines.slice(1)) {
    expect(line).toContain(",DEMO-MARKET-01,");
    expect(line).toMatch(/,driver,ended,[^,]*,bill_[0-9a-f]+,final,\d+,USD$/);
  }
});

test("demo: a period too long for its buckets shows stats_range_too_large; by month it works", async ({
  page,
  isMobile,
}) => {
  await openReports(page, isMobile);
  await page.getByLabel("Period", { exact: true }).selectOption("custom");
  await page.getByLabel("From", { exact: true }).fill("2026-01-01");
  await page.getByLabel("To", { exact: true }).fill("2026-06-30");
  await page.getByLabel("Group by").selectOption("day");
  await page.getByRole("button", { name: "Show report" }).click();
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "stats_range_too_large" });
  await expect(alert).toContainText("at most 92 day buckets");
  await expect(alert).toContainText("show it by month");
  await expect(page.getByText("Period too large")).toBeVisible();

  await page.getByLabel("Group by").selectOption("month");
  await page.getByRole("button", { name: "Show report" }).click();
  await expect(page.getByRole("heading", { name: "By month" })).toBeVisible();
  await expect(page.getByText("stats_range_too_large")).toHaveCount(0);
});

test("demo: the Reports page passes axe in light and dark and fits a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/reports");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`),
      scheme,
    ).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, "the page scrolls sideways").toBeLessThanOrEqual(0);
  }
});
