import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * The web build saves no card, and says so before sign-in: beside every "Sign in to
 * charge", that a start needs a card saved in the phone app. Offline demo, built with
 * no app links (map tiles blocked).
 */
const TILES = /tiles\.openfreemap\.org/;
const PLACE = "Town Hall Garage";
const WORDS = "To start a charge, you need a card saved in the phone app.";

async function openPlace(page: Page) {
  await page.route(TILES, (r) => r.abort());
  await page.goto("/");
  await page.getByTestId(`place-${PLACE}`).click();
  await expect(page.getByTestId("detail-price")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** `expo serve` has no rewrite for deep links: answer one with the app's page. */
async function deepLink(page: Page, path: string) {
  await page.route(TILES, (r) => r.abort());
  await page.route(`**${path}`, async (r) =>
    r.fulfill({ response: await page.request.get("/") }),
  );
  await page.goto(path);
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

for (const scheme of ["light", "dark"] as const)
  test(`a charger says it above "Sign in to charge" (${scheme})`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openPlace(page);
    const note = page.getByTestId("card-before-sign-in");
    await expect(note).toHaveCount(1);
    await expect(note).toHaveText(WORDS);
    await expect(note).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("charge")).toHaveText("Sign in to charge");
    // In the pinned footer, above the buttons.
    await expect(
      page.getByTestId("detail-footer").getByTestId("card-before-sign-in"),
    ).toBeVisible();
    const words = (await note.boundingBox())!;
    const button = (await page.getByTestId("charge").boundingBox())!;
    expect(words.y + words.height).toBeLessThanOrEqual(button.y);
    // No app address is configured in this build: no link to nowhere.
    await expect(page.getByTestId("phone-app-ios")).toHaveCount(0);
    await expect(page.getByTestId("phone-app-android")).toHaveCount(0);
    expect(await scan(page)).toEqual([]);
    await info.attach(`note-${scheme}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });

test("on a small phone it opens the details, and the buttons stay pinned", async ({
  page,
}, info) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 900, "phones only");
  await page.setViewportSize({ width: 320, height: 568 });
  await openPlace(page);
  const note = page.getByTestId("card-before-sign-in");
  const footer = page.getByTestId("detail-footer");
  await expect(footer.getByTestId("card-before-sign-in")).toHaveCount(0);
  await expect(note).toHaveCount(1);
  // Seen on arrival, without scrolling.
  await expect(note).toBeInViewport({ ratio: 1 });
  for (const id of ["directions", "charge"])
    await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 });
  expect((await footer.boundingBox())!.height).toBeLessThanOrEqual(568 / 3);
  const words = (await note.boundingBox())!;
  expect(words.y + words.height).toBeLessThanOrEqual(
    (await footer.boundingBox())!.y,
  );
  await info.attach("note-320", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  // Where the buttons end the page instead, the words stay right above them.
  await page.setViewportSize({ width: 320, height: 256 });
  await expect(footer).toHaveCount(0);
  await expect(note).toHaveCount(1);
  await note.scrollIntoViewIfNeeded();
  await expect(note).toBeInViewport();
  const above = (await note.boundingBox())!;
  const first = (await page.getByTestId("directions").boundingBox())!;
  expect(first.y - (above.y + above.height)).toBeGreaterThanOrEqual(0);
  expect(first.y - (above.y + above.height)).toBeLessThanOrEqual(16);
});

test("the Charging tab says it beside its sign-in button", async ({ page }) => {
  await page.route(TILES, (r) => r.abort());
  await page.goto("/");
  await page.getByTestId("tab-charging").click();
  await expect(page.getByTestId("charging-sign-in")).toBeVisible();
  await expect(page.getByTestId("card-before-sign-in")).toHaveText(WORDS);
  expect(await scan(page)).toEqual([]);
});

for (const path of ["/start", "/charge/any-charger"])
  test(`a link to ${path} says it before sign-in`, async ({ page }) => {
    await deepLink(page, path);
    await expect(
      page.getByRole("button", { name: "Sign in to charge" }),
    ).toBeVisible();
    await expect(page.getByTestId("card-before-sign-in")).toHaveText(WORDS);
    expect(await scan(page)).toEqual([]);
  });

test("a signed-in driver with a card is not told it again", async ({
  page,
}) => {
  await page.route(TILES, (r) => r.abort());
  await page.goto("/");
  await page.getByTestId("tab-account").click();
  await page.getByTestId("email-input").fill("driver@example.com");
  await page.getByTestId("send-code").click();
  await page.getByTestId("code-input").fill("000000");
  await page.getByTestId("verify-code").click();
  await expect(page.getByTestId("signed-in-email")).toBeVisible();
  await page.getByTestId("tab-index").click();
  await page.getByTestId(`place-${PLACE}`).click();
  await expect(page.getByTestId("charge")).toHaveText("Charge here");
  await expect(page.getByTestId("card-before-sign-in")).toHaveCount(0);
  await page.getByTestId("charge").click();
  await expect(page.getByTestId("confirm-start")).toHaveText("Start charging");
  await expect(page.getByTestId("confirm-phone-app")).toHaveCount(0);
});
