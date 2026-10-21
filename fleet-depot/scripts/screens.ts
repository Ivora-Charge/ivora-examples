import { expect, test } from "@playwright/test";

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
};

let advanced = 0;

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
      // The demo clock persists across the four runs: advance it once, from
      // 16:30 to 21:30, when most vehicles are plugged in and sharing the cap.
      for (; advanced < 5; advanced++) {
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
      }
      await ctx.close();
    });
  }
}
