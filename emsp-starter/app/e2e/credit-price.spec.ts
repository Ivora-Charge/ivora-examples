import { expect, test, type Page } from "@playwright/test";
import { contrast } from "../brand";

/**
 * The phone's map credit covers no marker, and "Price not shared" on a list card is
 * quieter than a real price. Offline (map tiles blocked), in the offline demo.
 */
const TILES = /tiles\.openfreemap\.org/;

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 900;

async function open(page: Page, percent = 100) {
  // A weekday noon at the sample sites, so the same ones are open on every day.
  await page.clock.setFixedTime(new Date("2026-10-26T10:00:00Z"));
  await page.route(TILES, (r) => r.abort());
  await page.goto("/");
  await expect(page.getByTestId("place-Station Square")).toBeVisible();
  if (percent !== 100)
    await page.addStyleTag({
      content: `html { font-size: ${percent}% !important; }`,
    });
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Every marker on the map against the credit's strip (what is painted; the link's tap
 * target also reaches up above it, under the markers) and the sheet below it.
 */
const markers = (page: Page) =>
  page.evaluate(() => {
    const strip = document
      .querySelector('[data-testid="map-credit"]')!
      .getBoundingClientRect();
    const sheet = document
      .querySelector('[data-testid="sheet"]')!
      .getBoundingClientRect();
    return [
      ...document.querySelectorAll<HTMLElement>(".maplibregl-marker"),
    ].map((m) => {
      const r = m.getBoundingClientRect();
      return {
        name:
          m.querySelector('[role="button"]')?.getAttribute("aria-label") ??
          "you",
        top: Math.round(r.top),
        lift: Number(m.dataset.lift ?? 0),
        drawn: getComputedStyle(m).visibility !== "hidden",
        meets:
          r.left < strip.right &&
          r.right > strip.left &&
          r.top < strip.bottom &&
          r.bottom > strip.top,
        aboveSheet: r.bottom <= sheet.top,
      };
    });
  });

/** Waits for the camera to stop: the markers stay where they are for a moment. */
async function settle(page: Page) {
  await expect(page.getByTestId("cluster").first()).toBeAttached();
  let last = "";
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await markers(page));
        const still = now === last;
        last = now;
        return still;
      },
      { intervals: [400] },
    )
    .toBe(true);
}

/**
 * Drawn markers that meet the credit, and markers left undrawn although they would
 * show whole above the sheet.
 */
async function wrong(page: Page) {
  const all = await markers(page);
  return all.filter((m) => (m.drawn ? m.meets : m.aboveSheet));
}

// The default framing at 390×844, the same with large text, and smaller phones.
for (const [width, height, percent] of [
  [390, 844, 100],
  [390, 844, 130],
  [390, 664, 130],
  [360, 740, 100],
])
  test(`no marker meets the map's credit at ${width}×${height} and ${percent}% text`, async ({
    page,
  }) => {
    test.skip(!isPhone(page), "the phone layout only");
    await page.setViewportSize({ width, height });
    await open(page, percent);
    // Larger text frames the places again only for a new search.
    if (percent !== 100) {
      await page.getByTestId("search-input").fill("a");
      await page.getByTestId("search-input").fill("");
    }
    await settle(page);
    await expect.poll(() => wrong(page)).toEqual([]);
    // The map still shows its places.
    await expect(
      page.getByTestId("cluster").filter({ visible: true }),
    ).not.toHaveCount(0);

    // The credit stays readable, and its tap target full height and pressable.
    const credit = page.getByTestId("map-attribution");
    await expect(credit).toContainText("OpenStreetMap contributors");
    const target = await credit.boundingBox();
    expect(target!.height).toBeGreaterThanOrEqual(43.5);
    expect(
      await page.getByTestId("map-credit").evaluate((strip) => {
        const r = strip.getBoundingClientRect();
        return strip.contains(
          document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
        );
      }),
    ).toBe(true);
  });

test("a marker moved onto the credit is lifted clear of it, lower down not drawn, and back as it was", async ({
  page,
}) => {
  test.skip(!isPhone(page), "the phone layout only");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  await settle(page);
  // The drawn cluster nearest the middle of the screen, and how far its centre is
  // above the credit's middle.
  const cluster = await page.evaluate(() => {
    const strip = document
      .querySelector('[data-testid="map-credit"]')!
      .getBoundingClientRect();
    return [...document.querySelectorAll('[data-testid="cluster"]')]
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          name: el.getAttribute("aria-label")!,
          x: r.x + r.width / 2,
          toStrip: strip.y + strip.height / 2 - (r.y + r.height / 2),
          drawn: getComputedStyle(el).visibility !== "hidden",
        };
      })
      .filter((c) => c.drawn && c.x > 60 && c.x < innerWidth - 60)
      .sort(
        (a, b) =>
          Math.abs(a.x - innerWidth / 2) - Math.abs(b.x - innerWidth / 2),
      )[0];
  });
  const found = page.getByRole("button", { name: cluster.name });
  const mine = async () =>
    (await markers(page)).find((m) => m.name === cluster.name)!;
  const drag = async (by: number) => {
    // From an empty part of the map, left of the markers in its middle.
    const x = 20;
    const y = 180;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + by, { steps: 12 });
    // Rest before letting go, so the map does not glide on.
    await page.waitForTimeout(300);
    await page.mouse.up();
    await settle(page);
  };
  // Its centre 20 px above the credit's middle: lifted, still drawn and pressable.
  await drag(cluster.toStrip - 20);
  expect((await mine()).lift).toBeGreaterThan(0);
  await expect(found).toBeVisible();
  await found.click({ trial: true });
  await expect.poll(() => wrong(page)).toEqual([]);
  // 20 px below it: behind the sheet for the most part, so not drawn.
  await drag(40);
  await expect(found).toHaveCount(0);
  await expect.poll(() => wrong(page)).toEqual([]);
  await drag(-cluster.toStrip - 20);
  await expect(found).toBeVisible();
  expect((await mine()).lift).toBe(0);
  await expect.poll(() => wrong(page)).toEqual([]);
});

/** Opens the demo with the two free sample places sent without any price. */
async function openUnpriced(page: Page, scheme: "light" | "dark") {
  let changed = 0;
  await page.route(/\/_expo\/static\/js\/.*\.js$/, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      /price:\{free:!0,summary:"Free",currency:"EUR"\},last_updated/g,
      () => {
        changed++;
        return "price:null,last_updated";
      },
    );
    await route.fulfill({ response, body });
  });
  await page.emulateMedia({ colorScheme: scheme });
  await open(page);
  // Fails here, not later, if the sample data or the bundle's shape changes.
  expect(changed).toBe(2);
}

/** How a card's price, or the words in its place, is drawn, and the card behind it. */
const priceStyle = (page: Page, place: string) =>
  page
    .getByTestId(`place-${place}`)
    .getByTestId("place-price")
    .evaluate((el) => {
      const s = getComputedStyle(el);
      const hex = (rgb: string) =>
        `#${rgb
          .match(/\d+/g)!
          .slice(0, 3)
          .map((n) => Number(n).toString(16).padStart(2, "0"))
          .join("")}`;
      return {
        text: el.textContent,
        size: parseFloat(s.fontSize),
        weight: Number(s.fontWeight),
        family: s.fontFamily,
        color: hex(s.color),
        card: hex(
          getComputedStyle(el.closest('[role="button"]')!).backgroundColor,
        ),
      };
    });

for (const scheme of ["light", "dark"] as const)
  test(`"Price not shared" is quieter than a price on a phone's card, ${scheme}`, async ({
    page,
  }) => {
    test.skip(!isPhone(page), "the phone layout only");
    await openUnpriced(page, scheme);
    const price = await priceStyle(page, "Station Square");
    const none = await priceStyle(page, "Old Mill Lane");
    expect(price.text).toBe("€0.71");
    expect(none.text).toBe("Price not shared");
    expect(none.size).toBeLessThan(price.size);
    expect(none.size).toBeGreaterThanOrEqual(12);
    expect(none.weight).toBe(400);
    expect(none.weight).toBeLessThan(price.weight);
    expect(none.color).not.toBe(price.color);
    // Softer on the card than the price, and still WCAG AA.
    expect(contrast(none.color, none.card)).toBeLessThan(
      contrast(price.color, price.card),
    );
    expect(contrast(none.color, none.card)).toBeGreaterThanOrEqual(4.5);
  });

test("the desktop list draws the words as it draws a price, as before", async ({
  page,
}) => {
  test.skip(isPhone(page), "the desktop layout only");
  await openUnpriced(page, "light");
  const price = await priceStyle(page, "Station Square");
  const none = await priceStyle(page, "Old Mill Lane");
  expect(none.text).toBe("Price not shared");
  expect({ ...none, text: "" }).toEqual({ ...price, text: "" });
});
