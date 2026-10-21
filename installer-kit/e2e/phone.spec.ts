import { expect, test, type Page } from "@playwright/test";

// Phone width (Pixel 7 / iPhone 14). PHONE_WIDTHS=320,360,390,430 checks more.
const WIDTHS = (process.env.PHONE_WIDTHS ?? "390").split(",").map(Number);

/** Fails if the page scrolls sideways, naming the elements that stick out. */
async function expectNoHorizontalScroll(page: Page, step: string) {
  const { scrollWidth, innerWidth, offenders } = await page.evaluate(() => {
    const vw = window.innerWidth;
    const offenders = [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > vw + 0.5)
      .map(
        (el) =>
          el.tagName.toLowerCase() + (el.className ? `.${el.className}` : ""),
      )
      .slice(0, 5);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: vw,
      offenders,
    };
  });
  expect
    .soft(
      scrollWidth,
      `${step} at ${innerWidth}px scrolls sideways: ${offenders.join(", ")}`,
    )
    .toBeLessThanOrEqual(innerWidth);
}

for (const width of WIDTHS) {
  test(`phone ${width}px: no horizontal scroll on any wizard step`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");

    // 1. Site, with the existing location picker.
    await expect(page.getByLabel("Existing location")).toBeVisible();
    await page.getByLabel("Existing location").selectOption({ index: 2 });
    await expectNoHorizontalScroll(page, "1. Site");
    if (process.env.PHONE_SCREENSHOT)
      await page.screenshot({ path: process.env.PHONE_SCREENSHOT });
    await page.getByRole("button", { name: "Use this location" }).click();

    // 2. Add charger, then the one-time credentials and QR codes.
    await expect(
      page.getByRole("button", { name: "Add charger" }),
    ).toBeVisible();
    await page.getByLabel("Connectors").fill("2");
    await expectNoHorizontalScroll(page, "2. Add charger");
    await page.getByRole("button", { name: "Add charger" }).click();
    await expect(page.getByTestId("password")).toBeVisible();
    await expectNoHorizontalScroll(page, "2. Credentials");

    // 3-6. Connection, test, configuration, price and hand-over.
    await expect(page.getByText("Charger connected and booted")).toBeVisible({
      timeout: 15_000,
    });
    await expectNoHorizontalScroll(page, "3. Connection");
    await page.getByRole("button", { name: "Start test session" }).click();
    await expect(page.getByText(/Test charging/)).toBeVisible();
    await page.getByRole("button", { name: "Stop test session" }).click();
    await expect(page.getByText(/^Passed/)).toBeVisible();
    await page.getByRole("button", { name: "Read configuration" }).click();
    await expect(page.getByText("300 s")).toBeVisible();
    await page.getByRole("button", { name: "Apply and read back" }).click();
    await expect(page.getByText(/Charger answered/)).toBeVisible();
    await page.getByRole("button", { name: "Add to report" }).click();
    await expectNoHorizontalScroll(page, "4-6. Test, price, hand-over");

    // The sticker landing page.
    const sticker = page.getByRole("link", {
      name: /Sticker PDF, connector 2/,
    });
    const code = /\((\w{8})\)/.exec((await sticker.textContent())!)![1];
    await page.goto(`/s/${code}`);
    await expect(page.getByText(/connector\s+2/)).toBeVisible();
    await expectNoHorizontalScroll(page, "Sticker page");
  });
}
