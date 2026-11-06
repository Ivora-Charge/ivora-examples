import { expect, test } from "@playwright/test";

// Demo mode: the driver session page on the operator's own domain (/s/<id>) shows
// fixed sample sessions only. No checkout record, no Ivora call, nothing charged.

test("demo: a driver follows a sample session, stops it and sees the receipt", async ({
  page,
}) => {
  await page.goto("/s/demo-charging");
  await expect(
    page.getByRole("heading", { level: 1, name: "Charging" }),
  ).toBeVisible();
  await expect(page.getByText("Demo session: sample data only")).toBeVisible();
  await expect(page.getByTestId("session-energy")).toHaveText("7.45 kWh");
  await expect(page.getByTestId("session-cost")).toHaveText("$3.61");
  // No staff shell around a driver page.
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);

  await page.getByRole("link", { name: "Stop charging" }).click();
  await expect(page).toHaveURL(/\/s\/demo-stopping$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Stopping" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Show the receipt" }).click();
  await expect(page).toHaveURL(/\/s\/demo-finished$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Finished" }),
  ).toBeVisible();
  const receipt = page.getByRole("region", { name: "Receipt" });
  await expect(receipt.getByTestId("receipt-charged")).toHaveText("$4.20");
  await expect(receipt).toContainText("Demo receipt: no card was charged");
});

test("demo: the starting state, and the sticker page links to the sample", async ({
  page,
}) => {
  await page.goto("/s/demo-starting");
  await expect(
    page.getByRole("heading", { level: 1, name: "Starting" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Stop/ })).toHaveCount(0);
});

test("an unknown session id answers 404", async ({ page }) => {
  for (const id of ["nope", "30000000-0000-4000-8000-0000000000ff", "demo-x"]) {
    const res = await page.goto(`/s/${id}`);
    expect(res?.status(), id).toBe(404);
    await expect(
      page.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeVisible();
  }
});
