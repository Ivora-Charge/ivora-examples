import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectAccessible, goTo, signIn } from "./support";

/**
 * Setup's generator, in a browser: the values it makes, the copy button, and that no
 * request, cookie or browser storage ever carries one. Runs on the desktop and mobile
 * projects (see playwright.config.ts).
 */
const FORMATS = {
  OCPI_TOKEN_ENCRYPTION_KEY: /^[A-Za-z0-9+/]{43}=$/,
  CRON_SECRET: /^[A-Za-z0-9_-]{43}$/,
} as const;
type Name = keyof typeof FORMATS;

/** Everything this tab sends from now on: addresses, headers and bodies, as text. */
function watch(page: Page) {
  const sent: { method: string; text: string }[] = [];
  page.context().on("request", (request) => {
    // Read at once: a request that a navigation cancels never gives up more. The
    // cookies, which these headers leave out, are checked with what the browser keeps.
    sent.push({
      method: request.method(),
      text: [
        request.url(),
        JSON.stringify(request.headers()),
        request.postDataBuffer()?.toString("utf8") ?? "",
      ].join("\n"),
    });
  });
  return sent;
}

/** Whether `text` holds the value, as it is or as an address would carry it. */
const holds = (text: string, value: string) =>
  [value, encodeURIComponent(value), value.replace(/=+$/, "")].some((form) =>
    text.includes(form),
  );

async function generate(scope: Locator, name: Name) {
  await scope.getByRole("button", { name: `Generate ${name}` }).click();
  const group = scope.getByRole("group", { name: `New value for ${name}` });
  await expect(group).toBeFocused();
  await expect(group).toContainText("Environment Variables");
  await expect(group).toContainText("Then redeploy");
  const value = await group.getByLabel(`Value of ${name}`).innerText();
  expect(value).toMatch(FORMATS[name]);
  // Shown once: the button that made it is gone, so it is not replaced unnoticed.
  await expect(
    scope.getByRole("button", { name: `Generate ${name}` }),
  ).toHaveCount(0);
  await group.getByRole("button", { name: `Copy Value of ${name}` }).click();
  expect(
    await scope.page().evaluate(() => navigator.clipboard.readText()),
  ).toBe(value);
  return value;
}

/** What the browser keeps: both storages, the cookies and the address. */
const kept = async (page: Page) =>
  JSON.stringify([
    await page.evaluate(() => [
      { ...localStorage },
      { ...sessionStorage },
      document.cookie,
      location.href,
      JSON.stringify(history.state),
    ]),
    await page.context().cookies(),
  ]);

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

test("a visitor before the first admin makes both values in the browser", async ({
  page,
}) => {
  await page.goto("/admin");
  await page.waitForLoadState("networkidle");
  const sent = watch(page);
  const main = page.getByRole("main");
  const values = [
    await generate(main, "OCPI_TOKEN_ENCRYPTION_KEY"),
    await generate(main, "CRON_SECRET"),
  ];
  await expect(main).toContainText("after peers are registered");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `generated values, visitor, ${colorScheme}`);
  }
  const storage = await kept(page);

  // Away and back: the values are gone and the buttons are there again.
  await goTo(page, "Peers");
  // Wait for the page: a second click sooner would be overtaken by the first.
  await expect(
    page.getByRole("heading", { name: "Peers", level: 1 }),
  ).toBeVisible();
  await goTo(page, "Setup");
  await expect(main.getByRole("button", { name: /^Generate / })).toHaveCount(2);
  for (const value of values) await expect(main).not.toContainText(value);
  await page.reload();
  await expect(main.getByRole("button", { name: /^Generate / })).toHaveCount(2);
  await page.waitForLoadState("networkidle");

  expect(sent.length).toBeGreaterThan(0);
  // A visitor's page posts nothing at all.
  expect(sent.filter((r) => r.method !== "GET")).toEqual([]);
  const wire = sent.map((r) => r.text);
  for (const value of values) {
    expect(wire.filter((text) => holds(text, value))).toEqual([]);
    expect(holds(storage, value)).toBe(false);
    expect(holds(await kept(page), value)).toBe(false);
  }
});

test("a signed-in admin's value is not in anything the page posts afterwards", async ({
  page,
}) => {
  await signIn(page);
  await goTo(page, "Setup");
  const stop = page.locator("#stop-1");
  await expect(stop).toContainText("settings need you");
  await page.waitForLoadState("networkidle");
  const sent = watch(page);
  const value = await generate(stop, "OCPI_TOKEN_ENCRYPTION_KEY");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `generated value, admin, ${colorScheme}`);
  }
  const storage = await kept(page);

  // Server actions are posted from here on (the lists, the setup status again).
  await goTo(page, "Peers");
  await expect(page.getByRole("list", { name: "Peers" })).toBeVisible();
  await page.reload();
  await goTo(page, "Setup");
  await expect(
    stop.getByRole("button", {
      name: "Generate OCPI_TOKEN_ENCRYPTION_KEY",
    }),
  ).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText(value);
  await page.waitForLoadState("networkidle");

  expect(sent.some((r) => r.method === "POST")).toBe(true);
  const wire = sent.map((r) => r.text);
  expect(wire.filter((text) => holds(text, value))).toEqual([]);
  expect(holds(storage, value)).toBe(false);
});
