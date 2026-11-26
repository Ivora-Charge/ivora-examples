import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Places at one coordinate: their cluster lists them instead of zooming. The sample
 * data has none, so the test moves places in the served bundle: three onto Station
 * Square, and one 67 m north of it, so a wider cluster has to be zoomed into first.
 */
const TILES = /tiles\.openfreemap\.org/;

const MOVES: [from: string, to: string][] = [
  // Harbour Front, Library Plaza, Hospital Car Park, and Market Hall (the neighbour).
  ["52.09574", "52.09274"],
  ["5.12842", "5.12542"],
  ["52.08774", "52.09274"],
  ["5.13442", "5.12542"],
  ["52.10374", "52.09274"],
  ["5.11642", "5.12542"],
  ["52.08474", "52.09334"],
  ["5.13142", "5.12542"],
];
const STACKED = [
  "Harbour Front",
  "Hospital Car Park",
  "Library Plaza",
  "Station Square",
];

async function open(page: Page) {
  const moved = new Set<string>();
  await page.route(TILES, (r) => r.abort());
  await page.route(/\/_expo\/static\/js\/.*\.js$/, async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    for (const [from, to] of MOVES) {
      if (body.includes(from)) moved.add(from);
      body = body.replaceAll(from, to);
    }
    await route.fulfill({ response, body });
  });
  await page.goto("/");
  await expect(page.getByTestId("place-Station Square")).toBeVisible();
  // Fails here, not later, if the sample data or the bundle's shape changes.
  expect(moved.size).toBe(MOVES.length);
}

const spot = (page: Page) =>
  page.getByRole("button", {
    name: "4 places at this spot. Choose one from a list",
  });

/** From the first view to the stack's own cluster: the wider one zooms in. */
async function toSpot(page: Page) {
  const wider = page.getByRole("button", {
    name: "5 places. Zoom in to see them",
  });
  await expect(wider).toBeVisible();
  await wider.click();
  await expect(page.getByTestId("cluster-chooser")).toHaveCount(0);
  await expect(page.getByTestId("marker-Market Hall")).toBeVisible();
  await expect(spot(page)).toBeVisible();
}

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 900;

test("a cluster at one coordinate opens a chooser of its places", async ({
  page,
}) => {
  await open(page);
  await toSpot(page);
  // One cluster, no pins stacked under it.
  for (const name of STACKED)
    await expect(page.getByTestId(`marker-${name}`)).toHaveCount(0);
  await expect(spot(page)).toHaveAttribute("aria-haspopup", "dialog");

  await spot(page).click();
  const dialog = page.getByRole("dialog", { name: "4 places at this spot" });
  await expect(dialog).toBeVisible();
  for (const name of STACKED)
    await expect(dialog.getByTestId(`place-${name}`)).toBeVisible();
  await expect(dialog.getByTestId("place-Market Hall")).toHaveCount(0);
  // Name, address, availability and price, as in the list.
  const row = dialog.getByTestId("place-Station Square");
  const listed = page.getByTestId("place-Station Square").first();
  await expect(row.getByTestId("place-address")).toHaveText(/\S, \S/);
  await expect(row).toContainText(/\d of 2 free|In use|Out of order/);
  await expect(row).toContainText("€0.7139");
  await expect(listed).toContainText("€0.7139");
  const [scroll, width] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(scroll).toBeLessThanOrEqual(width);

  await row.click();
  await expect(page.getByTestId("cluster-chooser")).toHaveCount(0);
  await expect(page.getByTestId("detail-name")).toHaveText("Station Square");

  // Back on the map the chooser stays closed, and the other places are one press away.
  await page.getByTestId("detail-close").click();
  await expect(page.getByTestId("detail-name")).toHaveCount(0);
  await expect(page.getByTestId("cluster-chooser")).toHaveCount(0);
  await spot(page).click();
  await dialog.getByTestId("place-Library Plaza").click();
  await expect(page.getByTestId("detail-name")).toHaveText("Library Plaza");
  if (!isPhone(page))
    await expect(page.getByTestId("detail-card")).toBeVisible();
});

test("going back from a charger's page keeps the map and list as they were", async ({
  page,
}) => {
  test.skip(!isPhone(page), "wide screens show a card beside the map");
  // Camera moves jump instead of easing, so positions are final once seen.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  await toSpot(page);
  const place = () => spot(page).boundingBox();
  const before = await place();
  const row = page.getByTestId("sheet").getByTestId("place-Town Hall Garage");
  await row.scrollIntoViewIfNeeded();
  const listed = await row.boundingBox();

  await row.click();
  await expect(page.getByTestId("detail-name")).toHaveText("Town Hall Garage");
  // Covered, not thrown away: a sheet built anew would frame the results again.
  await expect(page.getByTestId("sheet")).toHaveCount(1);
  await page.getByTestId("detail-close").click();
  await expect(page.getByTestId("detail-name")).toHaveCount(0);

  await expect.poll(() => row.boundingBox()).toEqual(listed);
  await expect.poll(place).toEqual(before);
});

test("the chooser works by keyboard, and closes without choosing", async ({
  page,
}) => {
  await open(page);
  await toSpot(page);
  const dialog = page.getByRole("dialog", { name: "4 places at this spot" });
  const close = page.getByTestId("cluster-chooser-close");

  await spot(page).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();
  // Focus stays in the dialog, both ways round.
  const inside = () =>
    dialog.evaluate((d) => d.contains(document.activeElement));
  for (const key of ["Shift+Tab", "Shift+Tab", "Tab", "Tab", "Tab"]) {
    await page.keyboard.press(key);
    expect(await inside()).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("cluster-chooser")).toHaveCount(0);
  await expect(spot(page)).toBeFocused();

  await spot(page).click();
  await close.click();
  await expect(page.getByTestId("cluster-chooser")).toHaveCount(0);

  await spot(page).click();
  await page
    .getByTestId("cluster-chooser-backdrop")
    .click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId("cluster-chooser")).toHaveCount(0);
  await expect(page.getByTestId("detail-name")).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const)
  test(`axe finds nothing on the chooser (${scheme})`, async ({ page }) => {
    // Reduced motion too: the dialog must still open and close.
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await open(page);
    await toSpot(page);
    await spot(page).click();
    await expect(page.getByTestId("cluster-chooser")).toBeVisible();
    const { violations } = await new AxeBuilder({ page })
      .exclude(".maplibregl-canvas")
      .analyze();
    expect(
      violations
        .filter((v) => v.impact !== "minor")
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`),
    ).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("chooser.png") });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("cluster-chooser")).toHaveCount(0);
  });
