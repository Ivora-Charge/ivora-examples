import { expect, test } from "@playwright/test";

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
};

for (const [device, viewport] of Object.entries(VIEWPORTS)) {
  for (const scheme of ["light", "dark"] as const) {
    test(`screens: ${device} ${scheme}`, async ({ browser }) => {
      const ctx = await browser.newContext({
        viewport,
        colorScheme: scheme,
        deviceScaleFactor: device === "phone" ? 2 : 1,
      });
      const page = await ctx.newPage();
      // A sticky step bar would repeat inside a full-page capture.
      const shot = async (name: string) => {
        await page.addStyleTag({
          content: ".steps{position:static !important}",
        });
        await page.screenshot({
          path: `docs/screens/${name}-${device}-${scheme}.png`,
          fullPage: true,
          animations: "disabled",
        });
      };

      await page.goto("/");
      await shot("landing");

      await page.getByRole("link", { name: "Try the demo" }).click();
      await expect(page.getByLabel("Existing location")).toBeVisible();
      await shot("site");
      await page.getByLabel("Existing location").selectOption({ index: 1 });
      await page.getByRole("button", { name: "Use this location" }).click();
      await page.getByRole("button", { name: "Add charger" }).click();
      await expect(page.getByTestId("password")).toBeVisible();
      await shot("connect");

      await expect(page.getByText("Charger connected and booted")).toBeVisible({
        timeout: 15_000,
      });
      await page.getByRole("button", { name: "Start test session" }).click();
      await expect(page.getByText(/Test charging/)).toBeVisible();
      await page.waitForTimeout(1200);
      await shot("test");
      await page.getByRole("button", { name: "Stop test session" }).click();
      await expect(page.getByText(/^Passed/)).toBeVisible();
      await page.getByLabel("Price per kWh (cents)").fill("40");
      await page.getByRole("button", { name: "Add to report" }).click();
      await page.getByRole("button", { name: "Mark in service" }).click();
      await expect(page.getByText(/In service since 20/)).toBeVisible();
      await shot("handover");
      await ctx.close();
    });
  }
}
