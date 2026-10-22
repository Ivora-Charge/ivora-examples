import { expect, test } from "@playwright/test";

/**
 * The README's screenshots, on demand only: SCREENSHOT=1 npm run test:e2e -- screenshots.
 * Unlike the other tests these let the map tiles load (from OpenFreeMap, no key), so
 * they need the network.
 */
test.skip(!process.env.SCREENSHOT, "only with SCREENSHOT=1");

for (const scheme of ["light", "dark"] as const)
  test(`screenshot: ${scheme}`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await expect(page.getByTestId("place-Station Square")).toBeVisible();
    const phone = info.project.name === "mobile";
    if (!phone) await page.getByTestId("place-Station Square").click();
    await page.waitForTimeout(4000);
    await page.screenshot({
      path: `docs/${phone ? "phone" : "desktop"}-${scheme}.png`,
    });
  });
