import { expect, test } from "@playwright/test";
import { expectAccessible, goTo, signIn, type Place } from "./support";

// Runs on the desktop and mobile projects (see playwright.config.ts).
test("demo: Setup shows a visitor six names, none done, and the sign-in prompt", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("status").filter({ hasText: "Demo" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Get this network live", level: 1 }),
  ).toBeVisible();
  await expect(page).toHaveTitle(/^Setup · /);

  // Demo mode has no admin, so a visitor sees the six stops by name, none done.
  const progress = page.getByRole("list", { name: "Setup progress" });
  await expect(progress.getByRole("listitem")).toHaveCount(6);
  await expect(progress.getByText("Not done")).toHaveCount(6);
  await expect(progress).toContainText("4 · SCHEDULED JOB");
  await expect(
    page.getByRole("heading", { name: "Setup so far: 0 of 6 done" }),
  ).toBeVisible();
  // Then one prompt with a link: no fix, no setting's name, no secret field.
  await expect(
    page.getByRole("heading", {
      name: "Sign in as an admin to see this deployment's setup",
    }),
  ).toBeVisible();
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/admin/sign-in",
  );
  await expect(page.getByRole("list", { name: "Setup checklist" })).toHaveCount(
    0,
  );
  await expect(main).not.toContainText(/STRIPE|CRON_SECRET|is not set|ZZ-DMO/);
  await expect(page.getByLabel("Admin secret")).toHaveCount(0);
  // Nor does the page's own data say whether the payment or job secrets are set.
  // (e2e/signed-out.spec.ts reads the same from a wrongly set up deployment.)
  expect(await page.content()).not.toMatch(
    /stripeKey|webhookSecret|cronSecret|secretEnabled|STRIPE_|CRON_SECRET|ADMIN_SECRET/,
  );
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `setup, signed out, ${colorScheme}`);
  }
});

test("demo: Setup shows a signed-in admin the six stops and the OCPI version", async ({
  page,
}) => {
  await signIn(page);
  await goTo(page, "Setup");

  // Demo mode is never called live or Health, and nothing in it counts as done.
  const hero = page.getByRole("region", { name: "Overall state" });
  await expect(hero).toContainText("Demo mode: 0 of 6 done");
  await expect(page.getByText("Live", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Health" })).toHaveCount(0);

  const lane = page.getByRole("list", { name: "Setup checklist" });
  await expect(lane.locator("> li")).toHaveCount(6);
  // The setup status read answers the admin secret too: stop 1 names what keeps
  // this server in demo mode, by name only.
  const first = lane.locator("#stop-1");
  await expect(first).toContainText("settings need you");
  await expect(first).toContainText("EMSP_COUNTRY_CODE is not set.");
  await expect(first).toContainText("DEMO_MODE is set");
  await expect(first).toContainText("openssl rand -base64 32");
  // Every later stop waits for the environment: demo mode has nothing behind them.
  for (const stop of ["#stop-2", "#stop-3", "#stop-4", "#stop-5"])
    await expect(lane.locator(stop)).toContainText("Waiting");
  await expect(lane.locator("#stop-2")).toContainText(
    "No database in demo mode",
  );
  await expect(lane.locator("#stop-6")).toContainText("The mock CPO stands in");

  const about = page.getByRole("complementary", {
    name: "About this deployment",
  });
  await expect(about).toContainText("OCPI 2.2.1");
  // Our party is sent with the page only to an admin signed in by email; with the
  // admin secret the page names the public API that answers it.
  await expect(about).toContainText("GET /api/v1/status");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `setup, signed in, ${colorScheme}`);
  }
});

test("the menu reaches every place: a rail on desktop, a tab bar and More on a phone", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  const rail = page.getByRole("navigation", { name: "Admin", exact: true });
  const tabs = page.getByRole("navigation", { name: "Admin, phone" });
  await expect(rail).toBeVisible({ visible: !isMobile });
  await expect(tabs).toBeVisible({ visible: isMobile });

  const places: [Place, string][] = [
    ["Peers", "Peers"],
    ["Sessions", "Sessions"],
    ["Problems", "Problems"],
    ["Payments", "Payments"],
    ["Reconciliation", "Reconciliation"],
    ["Drivers and tokens", "Drivers and tokens"],
    ["Account", "Sign in"],
    ["Setup", "Get this network live"],
  ];
  for (const [place, heading] of places) {
    await goTo(page, place);
    await expect(
      page.getByRole("heading", { name: heading, level: 1 }),
    ).toBeVisible();
    // Every place says where you are, and none asks for a secret.
    const current = (isMobile ? tabs : rail).locator('[aria-current="page"]');
    await expect(current.first()).toBeVisible();
    await expect(page.getByLabel("Admin secret")).toHaveCount(0);
  }
  if (isMobile) {
    // The sheet closes once a link in it is followed.
    await goTo(page, "Problems");
    await expect(
      tabs.getByRole("link", { name: "Reconciliation" }),
    ).toBeHidden();
  }
});

test("demo: status API reports demo mode", async ({ request }) => {
  const res = await request.get("/api/v1/status");
  expect(res.ok()).toBe(true);
  expect(res.headers()["access-control-allow-origin"]).toBe("*");
  expect(await res.json()).toMatchObject({
    mode: "demo",
    ocpi: { version: "2.2.1" },
  });
});

test("skip link moves focus to the main content", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "keyboard navigation is a desktop flow");
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await skip.press("Enter");
  await expect(page.locator("main")).toBeFocused();
});

test("the admin web uses the self-hosted brand fonts", async ({ page }) => {
  // Signed in: Setup shows settings' names in the mono face.
  await signIn(page);
  await goTo(page, "Setup");
  const heading = page.getByRole("heading", { name: "Get this network live" });
  await expect(heading).toBeVisible();
  const family = (l: ReturnType<typeof page.locator>) =>
    l.evaluate((el) => getComputedStyle(el).fontFamily);
  // next/font names each family after its constant in brand/fonts.ts, ahead of the
  // token's name.
  expect(await family(heading)).toMatch(/^\W*\w*bricolage/i);
  expect(await family(page.locator("body"))).toMatch(/^\W*\w*instrument/i);
  expect(await family(page.locator("code").first())).toMatch(/^\W*\w*mono/i);
  expect(
    await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((f) => f.status === "loaded")
        .map((f) => f.family);
    }),
  ).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/bricolage/i),
      expect.stringMatching(/instrument/i),
    ]),
  );
});
