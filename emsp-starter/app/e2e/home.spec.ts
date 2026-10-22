import { expect, test, type Page } from "@playwright/test";

/**
 * The driver app's web build in its offline demo (built without EXPO_PUBLIC_API_URL).
 * Runs on the desktop and mobile projects (see playwright.config.ts). Map tiles come
 * from OpenFreeMap, which is the only host outside the device the app may reach; the
 * tests block it, so they run offline and the app must still work without tiles.
 */
const TILES = /tiles\.openfreemap\.org/;

async function open(page: Page, path = "/") {
  const external: string[] = [];
  page.on("request", (r) => {
    const url = r.url();
    if (
      !url.startsWith("http://localhost:") &&
      !TILES.test(url) &&
      !url.startsWith("blob:") &&
      !url.startsWith("data:")
    )
      external.push(url);
  });
  await page.route(TILES, (r) => r.abort());
  await page.goto(path);
  await expect(page.getByTestId("demo-banner")).toBeVisible();
  return external;
}

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 900;

test("offline demo: the map screen is labelled demo, lists the sample chargers and sends nothing", async ({
  page,
}) => {
  const external = await open(page);
  await expect(page.getByTestId("demo-banner")).toContainText(
    "Sample chargers from a built-in test network",
  );
  await expect(
    page.getByRole("img", { name: "Kilolane" }).first(),
  ).toBeVisible();
  await expect(page.getByTestId("result-count")).toContainText("places");
  await expect(page.getByTestId("place-Station Square")).toBeVisible();
  await expect(page.getByTestId("place-Station Square")).toContainText(
    "€0.7139",
  );
  await expect(page.getByTestId("map-attribution")).toContainText(
    "OpenStreetMap contributors",
  );
  // No sideways scroll, even at 390 px.
  const [scroll, width] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(scroll).toBeLessThanOrEqual(width);
  expect(external).toEqual([]);
});

test("search by place, charger reference or EVSE ID, and filter", async ({
  page,
}) => {
  await open(page);
  const search = page.getByRole("searchbox", { name: "Search chargers" });
  await search.fill("market hall");
  await expect(page.getByTestId("result-count")).toHaveText(/^2 places/);
  await expect(page.getByTestId("place-Market Hall")).toBeVisible();

  await search.fill("ZZ*MCK*E11");
  await expect(page.getByTestId("result-count")).toHaveText(/^1 place\b/);
  await expect(page.getByTestId("place-Station Square")).toBeVisible();

  await search.fill("");
  await page.getByRole("checkbox", { name: "No fee" }).click();
  await expect(page.getByRole("checkbox", { name: "No fee" })).toBeChecked();
  await expect(page.getByTestId("place-Riverside Park")).toBeVisible();
  await expect(page.getByTestId("place-Station Square")).toHaveCount(0);

  await page.getByRole("checkbox", { name: "150 kW+" }).click();
  await expect(page.getByText("No chargers match")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByTestId("place-Station Square")).toBeVisible();
});

test("a charger's page: price from the tariff, connectors, hours and directions", async ({
  page,
}) => {
  await open(page);
  await page.getByTestId("place-Town Hall Garage").click();
  await expect(page.getByTestId("detail-name")).toHaveText("Town Hall Garage");
  await expect(page.getByTestId("detail-price")).toContainText("€0.4235");
  await expect(page.getByTestId("detail-price")).toContainText("per kWh");
  await expect(page.getByTestId("connector")).toHaveCount(2);
  await expect(page.getByTestId("connector").first()).toContainText(
    "Type 2 · 11 kW",
  );
  await expect(page.getByTestId("connector").first()).toContainText(
    "ZZ*MCK*E31",
  );
  await expect(page.getByText("Mon–Sat")).toBeVisible();
  await expect(page.getByTestId("directions")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in to charge" }),
  ).toBeVisible();
  await page.getByTestId("detail-close").click();
  if (isPhone(page))
    await expect(page.getByTestId("search-input")).toBeVisible();
  else await expect(page.getByTestId("detail-card")).toHaveCount(0);
});

test("passwordless sign-in: email, then the code (000000 in demo)", async ({
  page,
}) => {
  const external = await open(page);
  await page.getByTestId("tab-account").click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByTestId("demo-code-hint")).toContainText("000000");

  await page.getByTestId("send-code").click();
  await expect(page.getByRole("alert")).toHaveText(
    "Enter a valid email address.",
  );
  await page.getByTestId("email-input").fill("driver@example.com");
  await page.getByTestId("send-code").click();
  await expect(
    page.getByText("If driver@example.com can sign in"),
  ).toBeVisible();

  await page.getByTestId("code-input").fill("123456");
  await page.getByTestId("verify-code").click();
  await expect(page.getByRole("alert")).toContainText("wrong or has expired");

  await page.getByTestId("code-input").fill("000000");
  await page.getByTestId("verify-code").click();
  await expect(page.getByTestId("signed-in-email")).toHaveText(
    "driver@example.com",
  );

  await page.getByTestId("sign-out").click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(external).toEqual([]);
});

test("dark mode uses the dark tokens", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  await page.getByTestId("tab-charging").click();
  await expect(
    page.getByRole("heading", { name: "Charging", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    )
    .toBe("rgb(15, 13, 30)");
});
