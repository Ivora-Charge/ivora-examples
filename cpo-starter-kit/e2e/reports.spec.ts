import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

// Demo mode: six months of sample sessions, bills and payments on the sample chargers,
// made up offline (lib/server/ivora/demo-history.ts). Nothing is sent to Ivora or
// Stripe.

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
  "session_ref,session_type,status,created_at_utc,started_at_utc,ended_at_utc,time_zone,started_at_local,ended_at_local,duration_seconds,site,station_id,station,connector_id,connector_number,energy_wh,energy_kwh,stop_reason,transaction_id,bill_id,currency,hold_minor,billed_minor,captured_minor,refunded_minor,net_minor,refunds_checked_at_utc,details";

const yours = (page: Page) =>
  page.getByRole("region", { name: /^Your sessions \(this kit\)/ });

test("demo: Ivora's figures for every session, then your sessions with what was collected", async ({
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
    "Billed (final bills)",
  ])
    await expect(figures.getByText(label, { exact: false })).toBeVisible();
  await expect(figures).toContainText("$");
  await expect(
    page.getByText("Every session on your chargers, as Ivora counts them"),
  ).toContainText("sessions started outside this kit");
  await expect(page.getByRole("heading", { name: "By day" })).toBeVisible();
  await expect(page.getByText("America/New_York").first()).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Top chargers by energy" }),
  ).toContainText("DEMO-");
  await expect(page.getByRole("list", { name: "Chargers now" })).toContainText(
    "Faulted",
  );

  const sessions = yours(page);
  const totals = sessions.getByRole("region", {
    name: "Totals of your sessions",
  });
  for (const label of [
    "Collected (captured minus refunds)",
    "Refunded",
    "Billed (their final bills)",
    "Needs you",
  ])
    await expect(totals.getByText(label, { exact: false })).toBeVisible();
  await expect(sessions).toContainText(
    "staff/test sessions and sessions started outside this kit",
  );
  const table = sessions.getByRole("table");
  await expect(table.getByText("Free", { exact: true }).first()).toBeVisible();
  await expect(table.getByText("Driver (paid)").first()).toBeVisible();
  await expect(table.getByText("Staff/test")).toHaveCount(0);
  await expect(table.getByText(/UTC$/).first()).toBeVisible();
  await expect(table.getByText(/^ck_[0-9a-f]{32}$/).first()).toBeVisible();

  const payouts = page.getByRole("region", { name: "Payouts" });
  await expect(payouts).toContainText("The kit holds no Stripe keys");
  await expect(payouts).toContainText("Stripe asks you to sign in");
});

test("demo: refunded sessions, pages, and the same sessions as CSV", async ({
  page,
  isMobile,
}) => {
  await openReports(page, isMobile);
  await page.getByLabel("Period", { exact: true }).selectOption("90d");
  await page.getByRole("button", { name: "Show report" }).click();
  await expect(
    yours(page).getByRole("navigation", { name: "Session pages" }),
  ).toContainText("Page 1 of");
  await yours(page).getByRole("link", { name: "Older" }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(yours(page)).toContainText("Page 2 of");

  await page.getByLabel("Status (your sessions)").selectOption("refunded");
  await page.getByRole("button", { name: "Show report" }).click();
  await expect(page).toHaveURL(/status=refunded/);
  const table = yours(page).getByRole("table");
  await expect(table.getByText(/refunded$/).first()).toBeVisible();
  await expect(table.getByText("Free", { exact: true })).toHaveCount(0);

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
  const col = (name: string) => CSV_HEADER.split(",").indexOf(name);
  for (const line of lines.slice(1)) {
    const f = line.split(",");
    expect(f[col("session_type")]).toBe("paid");
    const captured = Number(f[col("captured_minor")]);
    const refunded = Number(f[col("refunded_minor")]);
    expect(refunded).toBeGreaterThan(0);
    expect(Number(f[col("net_minor")])).toBe(captured - refunded);
    expect(f[col("currency")]).toBe("USD");
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
    if (process.env.SCREENSHOT)
      await page.screenshot({
        path: `docs/screens/reports-phone-${scheme}.png`,
      });
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

test("demo: screenshots of Reports for the README (SCREENSHOT=1, desktop)", async ({
  page,
  isMobile,
}) => {
  test.skip(!process.env.SCREENSHOT || isMobile, "only when asked, on desktop");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/reports?period=7d");
    const top = await yours(page).boundingBox();
    await page.screenshot({
      path: `docs/screens/reports-desktop-${scheme}.png`,
      fullPage: true,
      clip: { x: 0, y: 0, width: 1280, height: (top?.y ?? 0) + 900 },
    });
  }
});
