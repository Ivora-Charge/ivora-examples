import { expect, test, type Page } from "@playwright/test";

/**
 * The tab labels at large text sizes: they are rem-sized, so the phone's bottom bar and
 * the wide layout's left rail have to make room for them, and for longer translations.
 * A large root font size stands in for the browser's text size setting. Offline (map
 * tiles blocked).
 */
const TILES = /tiles\.openfreemap\.org/;

// The focus ring: 3 px wide, 2 px outside its tab (WebStyles).
const RING = 5;

// The widest the rail gets (TabBar).
const RAIL_MAX = 200;

// Longer than the English: two words, and single words that cannot wrap.
const LONG = [
  "Übersichtskarte",
  "Ladevorgangsübersicht",
  "Mon portefeuille",
  "Mein Benutzerkonto",
];

// One word wider than a phone, and than the rail.
const ENDLESS = "Donaudampfschifffahrtsgesellschaftskapitän";

async function open(
  page: Page,
  width: number,
  height: number,
  percent: number,
) {
  await page.setViewportSize({ width, height });
  await page.route(TILES, (r) => r.abort());
  await page.goto("/");
  await expect(page.getByTestId("place-Station Square")).toBeVisible();
  await page.addStyleTag({
    content: `html { font-size: ${percent}% !important; }`,
  });
  await page.evaluate(() => document.fonts.ready);
}

// The app ships English only: put other words where a translation would.
const translate = (page: Page, words: string[]) =>
  page.getByRole("tab").evaluateAll((tabs, words) => {
    tabs.forEach((tab, i) => {
      (tab.lastElementChild!.firstChild as Text).data = words[i];
    });
  }, words);

/** Where the bar or rail and every word of its labels are drawn. */
function measure(page: Page) {
  return page
    .getByRole("navigation", { name: "Main" })
    .evaluate((nav: Element) => {
      const box = (r: DOMRect) => ({
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      });
      return {
        nav: box(nav.getBoundingClientRect()),
        tabs: [...nav.querySelectorAll('[role="tab"]')].map((tab) => {
          const el = tab.lastElementChild as HTMLElement;
          const node = el.firstChild as Text;
          const words = [...node.data.matchAll(/\S+/g)].map((m) => {
            const range = document.createRange();
            range.setStart(node, m.index);
            range.setEnd(node, m.index + m[0].length);
            // The word's width on one line, in the label's own font.
            const probe = el.cloneNode() as HTMLElement;
            probe.textContent = m[0];
            probe.style.cssText +=
              ";position:absolute;white-space:nowrap;max-width:none";
            tab.appendChild(probe);
            const natural = probe.getBoundingClientRect().width;
            probe.remove();
            return { natural, rects: [...range.getClientRects()].map(box) };
          });
          return {
            ...box(tab.getBoundingClientRect()),
            name: tab.getAttribute("aria-label"),
            text: node.data,
            fontSize: parseFloat(getComputedStyle(el).fontSize),
            overflow: el.scrollWidth - el.clientWidth,
            words,
          };
        }),
      };
    });
}

const noSidewaysScroll = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);

test.describe("the rail", () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) < 900,
    "the rail is only on wide screens",
  );

  /**
   * Every word is on screen and inside the rail, whole unless it is wider than a tab
   * can be, and each tab leaves room in the rail for its focus ring.
   */
  async function expectReadable(page: Page) {
    const { nav, tabs } = await measure(page);
    const { width, height } = page.viewportSize()!;
    expect(tabs).toHaveLength(4);
    expect(nav.left).toBeGreaterThanOrEqual(0);
    expect(nav.width).toBeLessThanOrEqual(RAIL_MAX);
    for (const tab of tabs) {
      expect(tab.left - nav.left).toBeGreaterThanOrEqual(RING);
      expect(nav.right - tab.right).toBeGreaterThanOrEqual(RING);
    }
    for (const { text, words, overflow, width: room } of tabs) {
      expect(overflow, `${text}: overflows its box`).toBeLessThanOrEqual(0);
      for (const { natural, rects } of words) {
        if (natural <= room + 0.5)
          expect(rects, `${text}: a word is broken in two`).toHaveLength(1);
        else expect(rects.length, `${text}: too long`).toBeGreaterThan(1);
        for (const r of rects) {
          expect(r.left, `${text}: left edge`).toBeGreaterThanOrEqual(nav.left);
          expect(r.right, `${text}: right edge`).toBeLessThanOrEqual(nav.right);
          expect(r.right, `${text}: off screen`).toBeLessThanOrEqual(width);
          expect(r.bottom, `${text}: below`).toBeLessThanOrEqual(height);
        }
      }
    }
    await noSidewaysScroll(page);
    return { rail: nav.width, tabs };
  }

  for (const [width, height] of [
    [900, 800],
    [1280, 720],
    [1440, 900],
  ]) {
    for (const percent of [100, 165, 200, 300])
      test(`its labels are readable at ${width} px and ${percent}% text`, async ({
        page,
      }, info) => {
        await open(page, width, height, percent);
        // At 300% the four tabs are taller than a short window.
        if (percent === 300)
          await page.setViewportSize({ width, height: 1200 });
        const { rail, tabs } = await expectReadable(page);
        // English never has to break, and takes two lines at most.
        for (const { text, words } of tabs) {
          for (const { rects } of words)
            expect(rects, `${text}: a word is broken in two`).toHaveLength(1);
          expect(words.length).toBeLessThanOrEqual(2);
        }
        // 92 px at the default text size; wider only as far as the words need.
        if (percent === 100) expect(rail).toBe(92);
        else expect(rail).toBeGreaterThan(92);
        expect(rail).toBeLessThan((92 * percent) / 100 + 1);
        await info.attach(`rail-${width}-${percent}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      });

    for (const percent of [100, 165, 200])
      test(`it fits longer labels at ${width} px and ${percent}% text`, async ({
        page,
      }, info) => {
        await open(page, width, height, percent);
        await translate(page, LONG);
        await expectReadable(page);
        await info.attach(`rail-long-${width}-${percent}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      });
  }

  for (const percent of [100, 200])
    test(`a word without end stops it at its widest, at ${percent}% text`, async ({
      page,
    }) => {
      await open(page, 900, 900, percent);
      await translate(page, [ENDLESS, "Charging", "Wallet", "Account"]);
      expect((await expectReadable(page)).rail).toBe(RAIL_MAX);
    });

  test("a soft hyphen says where a long word breaks", async ({ page }) => {
    await open(page, 1280, 720, 200);
    await translate(page, [
      "Map",
      "Verbrauchs\u00adübersicht",
      "Wallet",
      "Account",
    ]);
    const [first, second] = await page
      .getByTestId("tab-charging")
      .evaluate((tab) => {
        const node = tab.lastElementChild!.firstChild as Text;
        const at = node.data.indexOf("\u00ad");
        return [
          [0, at],
          [at, node.data.length],
        ].map(([from, to]) => {
          const range = document.createRange();
          range.setStart(node, from);
          range.setEnd(node, to);
          return [...range.getClientRects()]
            .filter((r) => r.width > 0)
            .map((r) => Math.round(r.top));
        });
      });
    // The first half, then the hyphen on its line, then the rest under them.
    expect(new Set(first).size).toBe(1);
    expect(second).toEqual([first[0], expect.any(Number)]);
    expect(second[1]).toBeGreaterThan(first[0]);
  });
});

test.describe("the phone's bar", () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) >= 900,
    "the bar is only on narrow screens",
  );

  /**
   * Every label is at the driver's text size, inside its own tab and on screen, clear
   * of its neighbours, and its words are whole unless wider than the screen. Returns
   * how many tabs each row holds.
   */
  async function expectReadable(page: Page, percent: number) {
    const { nav, tabs } = await measure(page);
    const { width, height } = page.viewportSize()!;
    expect(tabs).toHaveLength(4);
    expect(nav.left).toBe(0);
    expect(nav.width).toBe(width);
    expect(nav.bottom).toBeLessThanOrEqual(height);
    for (const tab of tabs) {
      const { text, words, overflow } = tab;
      expect(tab.fontSize).toBeCloseTo((13 * percent) / 100, 1);
      expect(overflow, `${text}: overflows its box`).toBeLessThanOrEqual(0);
      expect(tab.width, `${text}: tap target`).toBeGreaterThanOrEqual(44);
      expect(tab.height, `${text}: tap target`).toBeGreaterThanOrEqual(44);
      expect(tab.left, `${text}: tab off screen`).toBeGreaterThanOrEqual(0);
      expect(tab.right, `${text}: tab off screen`).toBeLessThanOrEqual(
        width + 0.5,
      );
      expect(tab.bottom, `${text}: tab below`).toBeLessThanOrEqual(height);
      // Room on both sides, so two labels side by side never run together.
      const side = (4 * percent) / 100 - 0.5;
      for (const { natural, rects } of words) {
        if (natural <= width - 2 * side - 1)
          expect(rects, `${text}: a word is broken in two`).toHaveLength(1);
        else expect(rects.length, `${text}: too long`).toBeGreaterThan(1);
        for (const r of rects) {
          expect(r.left - tab.left, `${text}: left`).toBeGreaterThanOrEqual(
            side,
          );
          expect(tab.right - r.right, `${text}: right`).toBeGreaterThanOrEqual(
            side,
          );
          expect(r.top, `${text}: above its tab`).toBeGreaterThanOrEqual(
            tab.top,
          );
          expect(r.bottom, `${text}: below its tab`).toBeLessThanOrEqual(
            tab.bottom + 0.5,
          );
        }
      }
    }
    tabs.forEach((a, i) => {
      for (const b of tabs.slice(i + 1))
        expect(
          a.right <= b.left + 0.5 || a.bottom <= b.top + 0.5,
          `${a.text} and ${b.text} overlap or are out of order`,
        ).toBe(true);
    });
    await noSidewaysScroll(page);
    const rows = new Map<number, number>();
    for (const { top } of tabs)
      rows.set(Math.round(top), (rows.get(Math.round(top)) ?? 0) + 1);
    return [...rows.values()];
  }

  for (const [width, height] of [
    [360, 640],
    [390, 844],
    [430, 932],
  ])
    for (const percent of [100, 130, 150, 175, 200]) {
      test(`its labels are readable at ${width} px and ${percent}% text`, async ({
        page,
      }, info) => {
        await open(page, width, height, percent);
        const rows = await expectReadable(page, percent);
        // One row, or two pairs: never three tabs and one.
        expect(["4", "2,2"]).toContain(rows.join());
        // One row while it holds the four; the narrowest need two at twice the size.
        if (percent <= 150) expect(rows).toEqual([4]);
        if (width === 360 && percent === 200) expect(rows).toEqual([2, 2]);
        // The names a screen reader says are the labels in view.
        for (const name of ["Map", "Charging", "Wallet", "Account"])
          await expect(page.getByRole("tab", { name })).toHaveText(name);
        await info.attach(`bar-${width}-${percent}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
        // Every tab still opens its screen from wherever the bar put it.
        await page.getByRole("tab", { name: "Account" }).click();
        await expect(page).toHaveURL(/\/account$/);
      });

      test(`it fits longer labels at ${width} px and ${percent}% text`, async ({
        page,
      }, info) => {
        await open(page, width, height, percent);
        await translate(page, LONG);
        await expectReadable(page, percent);
        await info.attach(`bar-long-${width}-${percent}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      });
    }

  test("a word wider than the screen breaks inside it", async ({ page }) => {
    await open(page, 360, 740, 200);
    await translate(page, ["Map", ENDLESS, "Wallet", "Account"]);
    await expectReadable(page, 200);
  });
});
