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
    // Phones: one step closer, so the clusters open into tiles of every status.
    else {
      await page.waitForTimeout(1500);
      // The largest cluster drawn whole on the map, above the sheet.
      const pick = await page.evaluate(() => {
        const sheet = document
          .querySelector('[data-testid="sheet"]')!
          .getBoundingClientRect();
        const map = document
          .querySelector(".maplibregl-map")!
          .getBoundingClientRect();
        let best = -1;
        let most = 0;
        document
          .querySelectorAll('[data-testid="cluster"]')
          .forEach((el, i) => {
            const r = el.getBoundingClientRect();
            const n = Number(el.textContent);
            if (r.top >= map.top && r.bottom <= sheet.top && n > most)
              [best, most] = [i, n];
          });
        return best;
      });
      await page.getByTestId("cluster").nth(pick).click();
    }
    await page.waitForTimeout(4000);
    await page.screenshot({
      path: `docs/${phone ? "phone" : "desktop"}-${scheme}.png`,
    });
  });

// The charging screen needs no map: its tiles stay blocked.
for (const scheme of ["light", "dark"] as const)
  test(`screenshot: charging, ${scheme}`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.route(/tiles\.openfreemap\.org/, (r) => r.abort());
    await page.goto("/");
    await page.getByTestId("tab-account").click();
    await page.getByTestId("email-input").fill("driver@example.com");
    await page.getByTestId("send-code").click();
    await page.getByTestId("code-input").fill("000000");
    await page.getByTestId("verify-code").click();
    await page.getByTestId("tab-charging").click();
    await page.getByTestId("charging-start").click();
    await page.getByTestId("charger-code").fill("ZZ*MCK*E11");
    await page.getByTestId("charger-find").click();
    await page.getByTestId("confirm-start").click();
    await expect(page.getByTestId("live-phase")).toHaveText("Charging");
    await page.waitForTimeout(8000);
    const phone = info.project.name === "mobile";
    await page.screenshot({
      path: `docs/charging-${phone ? "phone" : "desktop"}-${scheme}.png`,
    });
  });
