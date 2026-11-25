import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * A charger's detail: Directions and the charge action stay in view in a footer, on a
 * phone's page and on the wide screens' card, their labels never take three lines,
 * and every section has a heading. Offline (map tiles blocked).
 */
const TILES = /tiles\.openfreemap\.org/;
const PLACE = "Town Hall Garage";

async function open(
  page: Page,
  { signedIn = false, percent = 100 } = {},
): Promise<void> {
  await page.route(TILES, (r) => r.abort());
  // `expo serve` has no rewrite for deep links: start at the root.
  await page.goto("/");
  if (signedIn) {
    await page.getByTestId("tab-account").click();
    await page.getByTestId("email-input").fill("driver@example.com");
    await page.getByTestId("send-code").click();
    await page.getByTestId("code-input").fill("000000");
    await page.getByTestId("verify-code").click();
    await expect(page.getByTestId("signed-in-email")).toBeVisible();
    await page.getByTestId("tab-index").click();
  }
  await page.getByTestId(`place-${PLACE}`).click();
  await expect(page.getByTestId("detail-price")).toBeVisible();
  if (percent !== 100)
    await page.addStyleTag({
      content: `html { font-size: ${percent}% !important; }`,
    });
  await page.evaluate(() => document.fonts.ready);
}

/** Scrolls the details (not the window: the app's screens scroll inside) to an end. */
async function scrollDetails(page: Page, to: "top" | "end") {
  await page.getByTestId("detail-price").evaluate((el, to) => {
    let box = el.parentElement;
    while (box && !/auto|scroll/.test(getComputedStyle(box).overflowY))
      box = box.parentElement;
    box!.scrollTop = to === "end" ? box!.scrollHeight : 0;
  }, to);
}

/** The lines a button's label is drawn on. */
const labelLines = (page: Page, id: string) =>
  page.getByTestId(id).evaluate((button) => {
    const range = document.createRange();
    range.selectNodeContents(button.lastElementChild!);
    return new Set([...range.getClientRects()].map((r) => Math.round(r.top)))
      .size;
  });

/** Both buttons wholly on screen, their labels on two lines at most, no sideways scroll. */
async function expectActions(page: Page) {
  for (const id of ["directions", "charge"]) {
    await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 });
    expect(await labelLines(page, id), `${id}: lines`).toBeLessThanOrEqual(2);
  }
  const scroll = await page.evaluate(
    () => document.documentElement.scrollWidth,
  );
  expect(scroll).toBeLessThanOrEqual(page.viewportSize()!.width);
}

async function scan(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .exclude(".maplibregl-canvas")
    .analyze();
  return violations
    .filter((v) => v.impact !== "minor")
    .map(
      (v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`,
    );
}

test.describe("a phone's page", () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) >= 900,
    "wide screens show a card",
  );

  for (const [width, height] of [
    [390, 844],
    [360, 640],
    [320, 568],
  ])
    for (const signedIn of [false, true])
      test(`Directions and the charge action stay in view at ${width}x${height}, signed ${signedIn ? "in" : "out"}`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height });
        await open(page, { signedIn });
        const footer = page.getByTestId("detail-footer");
        await expect(footer).toBeVisible();
        await expectActions(page);
        const before = await footer.boundingBox();
        expect(Math.round(before!.y + before!.height)).toBe(height);
        expect(before!.height).toBeLessThanOrEqual(height / 3);
        await info.attach(`detail-${width}-${signedIn}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });

        await scrollDetails(page, "end");
        await expectActions(page);
        expect(await footer.boundingBox()).toEqual(before);
        // Report a problem stays with the details, above the footer, not under it.
        const report = page.getByTestId("detail-report");
        if (signedIn) {
          await expect(report).toBeInViewport({ ratio: 1 });
          const box = await report.boundingBox();
          expect(box!.y + box!.height).toBeLessThanOrEqual(before!.y);
        } else await expect(report).toHaveCount(0);
      });

  test("the buttons end the page where a footer would crowd the details", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, { signedIn: true });
    await expect(page.getByTestId("detail-footer")).toBeVisible();

    // As narrow and short as a page zoomed to 400%.
    await page.setViewportSize({ width: 320, height: 256 });
    await expect(page.getByTestId("detail-footer")).toHaveCount(0);
    for (const id of ["directions", "charge", "detail-report"]) {
      await expect(page.getByTestId(id)).toHaveCount(1);
      await page.getByTestId(id).scrollIntoViewIfNeeded();
      await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 });
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("detail-footer")).toBeVisible();
    await expect(page.getByTestId("charge")).toHaveCount(1);
    await scrollDetails(page, "top");
    await expectActions(page);
  });

  test("a phone on its side keeps the footer", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await open(page);
    await expect(page.getByTestId("detail-footer")).toBeVisible();
    await expectActions(page);
  });

  test("at 200% text the buttons stack and every control can be reached", async ({
    page,
  }, info) => {
    await open(page, { signedIn: true, percent: 200 });
    const directions = page.getByTestId("directions");
    const charge = page.getByTestId("charge");
    await expect
      .poll(async () => {
        const a = await directions.boundingBox();
        const b = await charge.boundingBox();
        return b!.y >= a!.y + a!.height;
      })
      .toBe(true);
    for (const id of ["directions", "charge", "detail-report"]) {
      await page.getByTestId(id).scrollIntoViewIfNeeded();
      await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 });
    }
    for (const id of ["directions", "charge"])
      expect(await labelLines(page, id)).toBeLessThanOrEqual(2);
    await info.attach("detail-200", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });

  test("the footer comes after the details for the keyboard, and sections are headed", async ({
    page,
  }) => {
    await open(page, { signedIn: true });
    for (const name of ["Price", "Connectors", "Opening hours"])
      await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
    await page.getByTestId("detail-report").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("directions")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("charge")).toBeFocused();
    expect(await scan(page)).toEqual([]);
  });
});

test.describe("the card on wide screens", () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) < 900,
    "phones show a page",
  );

  for (const [width, height] of [
    [900, 700],
    [1024, 768],
    [1440, 900],
  ])
    for (const signedIn of [false, true])
      test(`the buttons never take three lines at ${width} px, signed ${signedIn ? "in" : "out"}`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height });
        await open(page, { signedIn });
        await expect(page.getByTestId("detail-footer")).toBeVisible();
        await expectActions(page);
        const card = (await page.getByTestId("detail-card").boundingBox())!;
        for (const id of ["directions", "charge"]) {
          const box = (await page.getByTestId(id).boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(card.x);
          expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width);
        }
        // Report a problem scrolls with the details, so the card's foot stays small.
        if (signedIn) {
          await scrollDetails(page, "end");
          const report = page.getByTestId("detail-report");
          await expect(report).toBeInViewport({ ratio: 1 });
          const link = (await report.boundingBox())!;
          const first = (await page.getByTestId("directions").boundingBox())!;
          expect(link.y + link.height).toBeLessThanOrEqual(first.y);
        }
        await info.attach(`card-${width}-${signedIn}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      });

  test("a short card keeps room for the details above the buttons", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 600 });
    await open(page, { signedIn: true });
    await expect(page.getByTestId("detail-footer")).toBeVisible();
    await expectActions(page);
    const details = await page.getByTestId("detail-price").evaluate((el) => {
      let box = el.parentElement;
      while (box && !/auto|scroll/.test(getComputedStyle(box).overflowY))
        box = box.parentElement;
      return box!.clientHeight;
    });
    expect(details).toBeGreaterThanOrEqual(120);
  });

  test("at 200% text on a narrow card the whole card scrolls, all reachable", async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await open(page, { signedIn: true, percent: 200 });
    await expect(page.getByTestId("detail-footer")).toHaveCount(0);
    for (const id of [
      "detail-price",
      "directions",
      "charge",
      "detail-report",
      "detail-close",
    ]) {
      await expect(page.getByTestId(id)).toHaveCount(1);
      await page.getByTestId(id).scrollIntoViewIfNeeded();
      await expect(page.getByTestId(id)).toBeInViewport();
    }
    for (const id of ["directions", "charge"]) {
      await page.getByTestId(id).scrollIntoViewIfNeeded();
      await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 });
      expect(await labelLines(page, id)).toBeLessThanOrEqual(2);
    }
    await info.attach("card-200", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    // Back at the usual text size, the footer returns.
    await page.addStyleTag({
      content: "html { font-size: 100% !important; }",
    });
    await expect(page.getByTestId("detail-footer")).toBeVisible();
    await expect(page.getByTestId("charge")).toHaveCount(1);
  });

  test("every section of the card is headed one level below its name", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await open(page);
    const card = page.getByTestId("detail-card");
    await expect(
      card.getByRole("heading", { level: 2, name: PLACE }),
    ).toBeVisible();
    for (const name of ["Price", "Connectors", "Opening hours"])
      await expect(
        card.getByRole("heading", { level: 3, name }),
      ).toBeAttached();
    await expect(card.getByRole("heading", { level: 2 })).toHaveCount(1);
    expect(await scan(page)).toEqual([]);
  });
});
