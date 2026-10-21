import { expect, test } from "@playwright/test";

// Runs on the desktop and mobile projects (see playwright.config.ts).
test("offline demo: home is labelled demo and sends no request off the device", async ({
  page,
}) => {
  const external: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("http://localhost:")) external.push(r.url());
  });
  await page.goto("/");
  await expect(page.getByTestId("demo-banner")).toBeVisible();
  await expect(page.getByTestId("demo-banner")).toContainText(
    "Offline sample data",
  );
  await expect(
    page.getByRole("heading", { level: 1, name: "Your Charging Network" }),
  ).toBeVisible();
  await expect(page.getByText("Demo · OCPI 2.2.1")).toBeVisible();
  await expect(page.getByText("ZZ-DMO")).toBeVisible();
  await expect(page.getByText("Find a charger")).toBeVisible();
  expect(external).toEqual([]);

  if (process.env.SCREENSHOT)
    await page.screenshot({ path: "docs/screenshot.png", fullPage: false });
});
