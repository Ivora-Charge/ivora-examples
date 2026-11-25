import { expect, test, type Page } from "@playwright/test";

/**
 * The left rail at large text sizes: the labels are rem-sized, so the rail has to grow
 * with them, and with longer translations. A large root font size stands in for the
 * browser's text size setting. Offline (map tiles blocked).
 */
const TILES = /tiles\.openfreemap\.org/;

// The focus ring: 3 px wide, 2 px outside its tab (WebStyles).
const RING = 5;

// Longer than the English: two words, and single words that cannot wrap.
const LONG = [
  "Übersichtskarte",
  "Ladevorgangsübersicht",
  "Mon portefeuille",
  "Mein Benutzerkonto",
];

test.skip(
  ({ viewport }) => (viewport?.width ?? 0) < 900,
  "the rail is only on wide screens",
);

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

/** Where the rail and every word of its labels are drawn. */
function measure(page: Page) {
  return page
    .getByRole("navigation", { name: "Main" })
    .evaluate((nav: Element) => {
      const box = (r: DOMRect) => ({
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
      });
      return {
        rail: box(nav.getBoundingClientRect()),
        tabs: [...nav.querySelectorAll('[role="tab"]')].map((tab) =>
          box(tab.getBoundingClientRect()),
        ),
        labels: [...nav.querySelectorAll('[role="tab"]')].map((tab) => {
          const el = tab.lastElementChild as HTMLElement;
          const node = el.firstChild as Text;
          const words = [...node.data.matchAll(/\S+/g)].map((m) => {
            const range = document.createRange();
            range.setStart(node, m.index);
            range.setEnd(node, m.index + m[0].length);
            return [...range.getClientRects()].map(box);
          });
          return {
            text: node.data,
            words,
            overflow: el.scrollWidth - el.clientWidth,
          };
        }),
      };
    });
}

/**
 * Every word is whole, on screen and inside the rail, on at most two lines, and each
 * tab leaves room in the rail for its focus ring.
 */
async function expectReadable(page: Page) {
  const { rail, tabs, labels } = await measure(page);
  const { width, height } = page.viewportSize()!;
  expect(labels).toHaveLength(4);
  expect(rail.left).toBeGreaterThanOrEqual(0);
  for (const tab of tabs) {
    expect(tab.left - rail.left).toBeGreaterThanOrEqual(RING);
    expect(rail.right - tab.right).toBeGreaterThanOrEqual(RING);
  }
  for (const { text, words, overflow } of labels) {
    expect(overflow, `${text}: overflows its box`).toBeLessThanOrEqual(0);
    const lines = new Set<number>();
    for (const rects of words) {
      expect(rects, `${text}: a word is broken in two`).toHaveLength(1);
      const [r] = rects;
      expect(r.left, `${text}: left edge`).toBeGreaterThanOrEqual(rail.left);
      expect(r.right, `${text}: right edge`).toBeLessThanOrEqual(rail.right);
      expect(r.right, `${text}: off screen`).toBeLessThanOrEqual(width);
      expect(r.bottom, `${text}: below the screen`).toBeLessThanOrEqual(height);
      lines.add(Math.round(r.top));
    }
    expect(lines.size, `${text}: lines`).toBeLessThanOrEqual(2);
  }
  const scroll = await page.evaluate(
    () => document.documentElement.scrollWidth,
  );
  expect(scroll).toBeLessThanOrEqual(width);
  return rail.right - rail.left;
}

for (const [width, height] of [
  [1280, 720],
  [1440, 900],
])
  for (const percent of [100, 165, 200]) {
    test(`the rail's labels are readable at ${width} px and ${percent}% text`, async ({
      page,
    }, info) => {
      await open(page, width, height, percent);
      const rail = await expectReadable(page);
      // 92 px at the default text size; wider only as far as the words need.
      if (percent === 100) expect(rail).toBe(92);
      else expect(rail).toBeGreaterThan(92);
      expect(rail).toBeLessThan((92 * percent) / 100 + 1);
      await info.attach(`rail-${width}-${percent}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });

    test(`the rail fits longer labels at ${width} px and ${percent}% text`, async ({
      page,
    }, info) => {
      await open(page, width, height, percent);
      // The app ships English only: put the longer words where a translation would.
      await page.getByRole("tab").evaluateAll((tabs, long) => {
        tabs.forEach((tab, i) => {
          (tab.lastElementChild!.firstChild as Text).data = long[i];
        });
      }, LONG);
      await expectReadable(page);
      await info.attach(`rail-long-${width}-${percent}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });
  }
