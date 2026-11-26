import { expect, test, type Page } from "@playwright/test";

/**
 * A closed site's map marker, in the offline demo. Town Hall Garage's sample hours are
 * Monday to Saturday, 07:00–23:00 in Amsterdam; Market Hall is always open. The tests
 * fix the browser's clock, so they say the same on every day of the week.
 */
const TILES = /tiles\.openfreemap\.org/;
const SUNDAY = new Date("2026-10-25T10:00:00Z");
const MONDAY = new Date("2026-10-26T10:00:00Z");

/** The map framed on one place, so its marker is not part of a cluster. */
async function find(page: Page, name: string) {
  await page.getByRole("searchbox", { name: "Search chargers" }).fill(name);
  await expect(page.getByTestId("result-count")).toHaveText(/^1 place\b/);
  const marker = page.getByTestId(`marker-${name}`);
  await expect(marker).toBeVisible();
  return marker;
}

async function open(page: Page, now: Date) {
  await page.clock.setFixedTime(now);
  await page.route(TILES, (r) => r.abort());
  await page.goto("/");
  await expect(page.getByTestId("demo-banner")).toBeVisible();
}

test("a closed site's marker has the clock badge and says so, like its list card", async ({
  page,
}) => {
  await open(page, SUNDAY);
  const closed = await find(page, "Town Hall Garage");
  await expect(closed.getByTestId("marker-closed")).toBeVisible();
  await expect(closed).toHaveAccessibleName(
    /^Town Hall Garage: .+, Closed now$/,
  );
  await expect(
    page
      .getByTestId("place-Town Hall Garage")
      .getByTestId("place-closed-now")
      .first(),
  ).toHaveText("Closed now");
  // The badge sits inside the marker's own box, clear of the power reading. Both are
  // measured in the same frame: the map may still be easing to the search result, and
  // two separate reads could catch the marker at two different places.
  const { box, badge } = await closed.evaluate((el) => {
    const b = el.querySelector('[data-testid="marker-closed"]')!;
    return {
      box: el.getBoundingClientRect().toJSON() as DOMRect,
      badge: b.getBoundingClientRect().toJSON() as DOMRect,
    };
  });
  expect(badge.x + badge.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  expect(badge.y).toBeGreaterThanOrEqual(box.y - 0.5);

  const always = await find(page, "Market Hall");
  await expect(always.getByTestId("marker-closed")).toHaveCount(0);
  await expect(always).not.toHaveAccessibleName(/Closed/);
});

test("the same site's marker is unmarked while it is open", async ({
  page,
}) => {
  await open(page, MONDAY);
  const marker = await find(page, "Town Hall Garage");
  await expect(marker.getByTestId("marker-closed")).toHaveCount(0);
  await expect(marker).not.toHaveAccessibleName(/Closed/);
});
