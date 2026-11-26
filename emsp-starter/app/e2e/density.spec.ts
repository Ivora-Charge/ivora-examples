import { expect, test, type Page } from "@playwright/test";

/**
 * The phone's map screen in a mobile browser, whose bars leave less than the screen's
 * height: how many charger cards show under the map in the sheet's default position,
 * at the browser's text size and larger, with everything still big enough to read and
 * to tap. A large root font size stands in for the text size setting. Offline (map
 * tiles blocked), in the offline demo.
 */
const TILES = /tiles\.openfreemap\.org/;

test.skip(
  ({ viewport }) => (viewport?.width ?? 0) >= 900,
  "the phone layout only",
);

// 390×844 and 430×932 screens, less a mobile browser's bars.
const SIZES = [
  [390, 664],
  [430, 740],
] as const;

async function open(page: Page, percent: number) {
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

/** How many cards show above the sheet's lower edge: 2.5 is two and half a third. */
const cardsShown = (page: Page) =>
  page.getByTestId("sheet").evaluate((sheet) => {
    const edge = sheet.getBoundingClientRect().bottom;
    return [...sheet.querySelectorAll('[data-testid^="place-"][role="button"]')]
      .map((card) => {
        const r = card.getBoundingClientRect();
        return Math.max(0, Math.min(1, (edge - r.top) / r.height));
      })
      .reduce((sum, share) => sum + share, 0);
  });

/** What is too small to tap or to read, or spills out of its box. */
const faults = (page: Page) =>
  page.evaluate(() => {
    const found: string[] = [];
    const name = (el: Element) =>
      el.getAttribute("aria-label") ?? el.textContent?.slice(0, 40) ?? "";
    for (const el of document.querySelectorAll(
      'button, input, [role="button"], [role="checkbox"], [role="tab"], [role="link"]',
    )) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.height < 43.5 || r.width < 43.5))
        found.push(`small target: ${name(el)} ${r.width}×${r.height}`);
    }
    for (const el of document.querySelectorAll<HTMLElement>("div, span")) {
      const text = [...el.childNodes].some(
        (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
      );
      if (!text || el.closest(".maplibregl-map")) continue;
      if (parseFloat(getComputedStyle(el).fontSize) < 12)
        found.push(`small text: ${name(el)}`);
      if (el.clientWidth && el.scrollWidth > el.clientWidth + 1)
        found.push(`clipped across: ${name(el)}`);
      if (el.clientHeight && el.scrollHeight > el.clientHeight + 1)
        found.push(`clipped down: ${name(el)}`);
    }
    // Each card ends before the next begins, and its three parts stay side by side.
    const cards = [
      ...document.querySelectorAll(
        '[data-testid="sheet"] [data-testid^="place-"][role="button"]',
      ),
    ];
    cards.forEach((card, i) => {
      const box = card.getBoundingClientRect();
      const next = cards[i + 1]?.getBoundingClientRect();
      if (next && next.top < box.bottom) found.push(`overlap: ${name(card)}`);
      const parts = [...card.children].map((p) => p.getBoundingClientRect());
      parts.forEach((part, j) => {
        if (
          part.top < box.top ||
          part.bottom > box.bottom ||
          part.right > box.right ||
          (parts[j + 1] && parts[j + 1].left < part.right - 0.5)
        )
          found.push(`spills: ${name(card)}`);
      });
    });
    if (document.documentElement.scrollWidth > window.innerWidth)
      found.push("the page scrolls sideways");
    return found;
  });

for (const [width, height] of SIZES)
  for (const [percent, cards] of [
    [100, 2.5],
    [115, 1.5],
    [130, 1.5],
  ])
    test(`${cards} cards or more show at ${width}×${height} and ${percent}% text`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height });
      await open(page, percent);
      expect(await cardsShown(page)).toBeGreaterThanOrEqual(cards);
      expect(await faults(page)).toEqual([]);
      // A search adds the clear button.
      await page.getByTestId("search-input").fill("a");
      await expect(
        page.getByRole("button", { name: "Clear search" }),
      ).toBeVisible();
      expect(await faults(page)).toEqual([]);
      await info.attach(`density-${width}-${percent}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });

test("the search text is 16 px, so iOS Safari does not zoom to it", async ({
  page,
}) => {
  await open(page, 100);
  await expect(page.getByTestId("search-input")).toHaveCSS("font-size", "16px");
});

test("the map's credit is on one line, above any marker, and blocks none", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 664 });
  await open(page, 100);
  const credit = page.getByTestId("map-attribution");
  await expect(credit).toContainText("OpenStreetMap contributors");
  const found = await credit.evaluate((link) => {
    const strip = link.firstElementChild!;
    const s = strip.getBoundingClientRect();
    const target = link.getBoundingClientRect();
    // A stand-in for a cluster's marker, which has no level of its own, spread over
    // the whole map. It comes before the credit in the page, as the real ones do.
    const marker = document.createElement("div");
    marker.className = "maplibregl-marker";
    marker.style.cssText = "position:absolute;inset:0";
    const button = marker.appendChild(document.createElement("div"));
    button.setAttribute("role", "button");
    button.style.cssText = "width:100%;height:100%";
    document.querySelector(".maplibregl-map")!.appendChild(marker);
    const at = (y: number) =>
      document.elementFromPoint(s.left + s.width / 2, y);
    const result = {
      lines: Math.round(
        s.height / parseFloat(getComputedStyle(strip).fontSize),
      ),
      onStrip: strip.contains(at(s.top + s.height / 2)),
      aboveStrip: at(target.top + 4) === button,
    };
    marker.remove();
    return result;
  });
  expect(found).toEqual({ lines: 1, onStrip: true, aboveStrip: true });
});

/**
 * Where to press the cluster of the most places that shows whole between the top bar
 * and the sheet, and what it is called; nothing when no cluster shows there.
 */
const biggestCluster = (page: Page) =>
  page.getByTestId("sheet").evaluate((sheet) => {
    const edge = sheet.getBoundingClientRect().top;
    return [...document.querySelectorAll('[data-testid="cluster"]')]
      .map((el) => {
        const r = el.getBoundingClientRect();
        const name = el.getAttribute("aria-label")!;
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        const reached =
          r.bottom < edge && el.contains(document.elementFromPoint(x, y));
        return { x, y, name, reached };
      })
      .filter((c) => c.reached)
      .sort((a, b) => parseInt(b.name) - parseInt(a.name))[0];
  });

const markerNames = (page: Page) =>
  page
    .getByTestId("map")
    .getByRole("button")
    .evaluateAll((all) =>
      all.map((el) => el.getAttribute("aria-label")).sort(),
    );

for (const [width, height] of [...SIZES, [390, 844], [430, 932]])
  test(`pressing a cluster opens it up at ${width}×${height}`, async ({
    page,
  }) => {
    // Camera moves jump instead of easing.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width, height });
    await open(page, 100);
    await expect.poll(() => biggestCluster(page)).toBeDefined();
    let presses = 0;
    for (; presses < 6; presses++) {
      const cluster = await biggestCluster(page);
      if (!cluster) break;
      const before = await markerNames(page);
      await page.mouse.click(cluster.x, cluster.y);
      // No press is a dead end: each one changes what the map shows.
      await expect.poll(() => markerNames(page)).not.toEqual(before);
    }
    expect(presses).toBeGreaterThan(0);
    expect(presses).toBeLessThan(6);
    await expect(
      page.locator('[data-testid^="marker-"]').first(),
    ).toBeInViewport();
  });

test("a chip's keyboard focus ring stays inside its tap target", async ({
  page,
}) => {
  await open(page, 100);
  const chip = page.getByRole("checkbox", { name: "Open now" });
  await chip.focus();
  // Keyboard focus, so :focus-visible applies.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(chip).toBeFocused();
  await expect(chip).toHaveCSS("outline-offset", "-3px");
  await expect(chip).toHaveCSS("outline-style", "solid");
});

/**
 * Markers and clusters drawn whole on the map, between its top edge and the sheet, that
 * something else covers: the brand pill, the locate button, the demo strip or the
 * credit. Each is probed at its middle and a quarter of the way in from its top and
 * bottom.
 */
const coveredMarkers = (page: Page) =>
  page.evaluate(() => {
    const map = document
      .querySelector(".maplibregl-map")!
      .getBoundingClientRect();
    const sheet = document
      .querySelector('[data-testid="sheet"]')!
      .getBoundingClientRect();
    const found: string[] = [];
    let shown = 0;
    for (const m of document.querySelectorAll(
      '[data-testid="cluster"], [data-testid^="marker-"][role="button"]',
    )) {
      const r = m.getBoundingClientRect();
      if (r.top < map.top || r.bottom > sheet.top) continue;
      if (r.left < map.left || r.right > map.right) continue;
      shown++;
      const x = r.left + r.width / 2;
      for (const y of [0.25, 0.5, 0.75].map((f) => r.top + r.height * f)) {
        const hit = document.elementFromPoint(x, y);
        if (hit && m.contains(hit)) continue;
        const by =
          hit?.closest("[data-testid]")?.getAttribute("data-testid") ??
          hit?.closest("[role]")?.getAttribute("aria-label") ??
          hit?.tagName;
        found.push(`${m.getAttribute("aria-label")} under ${by}`);
        break;
      }
    }
    return { shown, found };
  });

for (const height of [664, 844])
  for (const percent of [100, 130])
    test(`no marker on the map is hidden by its controls at 390×${height} and ${percent}% text`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height });
      await open(page, percent);
      // The opening view frames you and the nearest places again for the larger text.
      await page.getByTestId("search-input").fill("a");
      await page.getByTestId("search-input").fill("");
      await expect(page.getByTestId("cluster").first()).toBeVisible();
      // Let the camera settle: the markers stay where they are for a moment.
      const spots = () =>
        page.evaluate(() =>
          [...document.querySelectorAll('[data-testid="cluster"]')]
            .map((m) => Math.round(m.getBoundingClientRect().top))
            .join(),
        );
      let last = "";
      await expect
        .poll(
          async () => {
            const now = await spots();
            const still = now === last;
            last = now;
            return still;
          },
          { intervals: [300] },
        )
        .toBe(true);
      expect((await coveredMarkers(page)).found).toEqual([]);
      expect((await coveredMarkers(page)).shown).toBeGreaterThan(0);
    });
