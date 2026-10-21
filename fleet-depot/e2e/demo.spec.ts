import { expect, test } from "@playwright/test";

test("demo: vehicles arrive, share the site cap, and show up in the report", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/");
  await expect(
    page.getByRole("status").filter({ hasText: "Demo" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Try the demo" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Demo" }),
  ).toBeVisible();
  await expect(page.getByText("not plugged in").first()).toBeVisible();

  // 16:30 -> 22:30: every vehicle has arrived.
  for (let i = 0; i < 6; i++) {
    const r = page.waitForResponse("**/api/state");
    await page.getByRole("button", { name: "Advance 1 h" }).click();
    await r;
  }
  await expect(page.getByText("DEMO-ST-1 / 6", { exact: true })).toBeVisible();
  await expect(page.getByText("not plugged in")).toHaveCount(0);
  await expect(
    page.getByText(/accepted \(\d+ W now, simulated\)/).first(),
  ).toBeVisible();

  // Edit a departure: labelled form, plan recomputed.
  await page.getByRole("tab", { name: "Vehicles and cards" }).click();
  await page.getByRole("button", { name: "Edit" }).first().click();
  await page.getByLabel("Target %").fill("80");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText("Saved; charging plan recomputed."),
  ).toBeVisible();

  // Report and CSV link.
  await page.getByRole("tab", { name: "Sessions and cost" }).click();
  await page.getByLabel("Group by").selectOption("driver");
  await expect(
    page.getByRole("link", { name: "Download CSV" }),
  ).toHaveAttribute("href", /by=driver&format=csv/);
  const csv = await page.request.get("/api/reports?by=driver&format=csv");
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect((await csv.text()).split("\n")[0]).toContain("cost");

  // Card import is labelled and reports per-line errors.
  await page.getByRole("tab", { name: "Vehicles and cards" }).click();
  await page
    .getByLabel(/Import cards as CSV/)
    .fill("idTag,driverName\nDEMO7001,Sample Driver\nbad tag!,X");
  await page.getByRole("button", { name: "Import cards (CSV)" }).click();
  await expect(page.getByText(/Imported 1, 1 rejected: line 3/)).toBeVisible();
});

test("demo: refuses cross-origin writes", async ({ request }) => {
  const r = await request.post("/api/state", {
    headers: { origin: "https://evil.example" },
    data: { action: "advance", minutes: 60 },
  });
  expect(r.status()).toBe(403);
});
