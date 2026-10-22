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
