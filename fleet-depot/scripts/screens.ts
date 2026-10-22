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
      const shot = (name: string) =>
        page.screenshot({
          path: `docs/screens/${name}-${device}-${scheme}.png`,
          fullPage: true,
          animations: "disabled",
        });

      await page.goto("/");
      await shot("landing");
      await page.getByRole("link", { name: "Try the demo" }).click();
      await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
      // The demo clock is shared by every run: start the night again and advance
      // it from 16:30 to 21:30, when the late van plugs in and is at risk.
      const reset = page.waitForResponse("**/api/state");
      await page.getByRole("button", { name: "Reset demo" }).click();
      await reset;
      for (let i = 0; i < 5; i++) {
        const r = page.waitForResponse("**/api/state");
        await page.getByRole("button", { name: "Advance 1 h" }).click();
        await r;
      }
      await expect(page.locator(".skel")).toHaveCount(0);
      await shot("overview");
      for (const [tab, name] of [
        ["Vehicles and cards", "vehicles"],
        ["Sessions and cost", "sessions"],
        ["Settings", "settings"],
      ]) {
        await page.getByRole("tab", { name: tab }).click();
        await shot(name);
      }
      if (device === "desktop") {
        await page.getByRole("button", { name: /Wall display/ }).click();
        await shot("wall-display");
        if (scheme === "dark") {
          // The TV: 1920x1080, dark.
          await page.setViewportSize({ width: 1920, height: 1080 });
          await page.screenshot({
            path: "docs/screens/wall-display-1920x1080-dark.png",
            animations: "disabled",
          });
        }
      }
      await ctx.close();
    });
  }
}
