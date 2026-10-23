import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * axe on the main screens, light and dark, offline (map tiles blocked). Fails on any
 * moderate, serious or critical finding.
 */
const TILES = /tiles\.openfreemap\.org/;

async function scan(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    // The map canvas is drawn by WebGL; its chargers are buttons axe does check.
    .exclude(".maplibregl-canvas")
    .analyze();
  return violations
    .filter((v) => v.impact !== "minor")
    .map(
      (v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`,
    );
}

for (const scheme of ["light", "dark"] as const)
  test(`axe finds nothing on the map, a charger and sign-in (${scheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.route(TILES, (r) => r.abort());
    await page.goto("/");
    await expect(page.getByTestId("place-Station Square")).toBeVisible();
    expect(await scan(page)).toEqual([]);

    await page.getByTestId("place-Station Square").click();
    await expect(page.getByTestId("detail-price")).toBeVisible();
    expect(await scan(page)).toEqual([]);

    await page.getByTestId("detail-close").click();
    await page.getByTestId("tab-account").click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(await scan(page)).toEqual([]);
  });

for (const scheme of ["light", "dark"] as const)
  test(`axe finds nothing on charging, the wallet, a receipt and a report (${scheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.route(TILES, (r) => r.abort());
    await page.goto("/");
    await page.getByTestId("tab-account").click();
    await page.getByTestId("email-input").fill("driver@example.com");
    await page.getByTestId("send-code").click();
    await page.getByTestId("code-input").fill("000000");
    await page.getByTestId("verify-code").click();
    await expect(page.getByTestId("notifications")).toBeVisible();
    expect(await scan(page)).toEqual([]);

    await page.getByTestId("tab-charging").click();
    await expect(page.getByTestId("history")).toBeVisible();
    expect(await scan(page)).toEqual([]);
    await page.getByTestId("charging-start").click();
    await expect(page.getByTestId("start-screen")).toBeVisible();
    expect(await scan(page)).toEqual([]);
    await page.getByTestId("charger-code").fill("ZZ*MCK*E11");
    await page.getByTestId("charger-find").click();
    await page.getByTestId("confirm-start").click();
    await expect(page.getByTestId("live-phase")).toHaveText("Charging");
    expect(await scan(page)).toEqual([]);
    await page.getByTestId("live-stop").click();
    await page.getByTestId("live-receipt").click();
    await expect(page.getByTestId("receipt")).toBeVisible();
    expect(await scan(page)).toEqual([]);
    await page.getByTestId("receipt-report").click();
    await expect(page.getByTestId("report-screen")).toBeVisible();
    expect(await scan(page)).toEqual([]);
    // Screens under the top one stay in the page, hidden: press the visible back.
    const back = page.getByTestId("page-back").filter({ visible: true });
    await back.click();
    await expect(page.getByTestId("receipt")).toBeVisible();
    await back.click();
    await page.getByTestId("tab-wallet").click();
    await expect(page.getByTestId("receipt-row")).toHaveCount(1);
    expect(await scan(page)).toEqual([]);
  });
