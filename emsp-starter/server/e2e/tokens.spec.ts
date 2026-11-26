import { expect, test } from "@playwright/test";
import { expectAccessible, goTo, signIn } from "./support";

// Demo mode: tokens live in memory and nothing is pushed to a CPO.
test("demo: a token is changed by its UID alone, from Tokens", async ({
  page,
}) => {
  await signIn(page);
  // A driver of this run, with an app token made on the driver's page.
  const driver = `e2e-uid-${test.info().project.name}-${Date.now()}`;
  await page.goto(`/admin/drivers/${driver}`);
  const tokens = page.getByRole("region", { name: "Tokens" });
  await tokens
    .getByRole("form", { name: "Create an app token" })
    .getByRole("button", { name: "Create app token" })
    .click();
  const item = tokens.getByRole("listitem").filter({ hasText: "App token" });
  const uid = (
    await item.getByRole("heading").locator(".mono").innerText()
  ).trim();

  await goTo(page, "Tokens");
  await expect(
    page.getByRole("heading", { name: "Tokens", level: 1 }),
  ).toBeVisible();
  await expect(page.getByLabel("Admin secret")).toHaveCount(0);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `tokens, signed in, ${colorScheme}`);
  }

  // A token is reached by its UID and type alone, without the driver.
  const byUid = page.getByRole("region", { name: "Change a token by its UID" });
  await byUid.getByLabel("Token UID").fill(uid);
  await byUid
    .getByRole("button", { name: "Unblock token", exact: true })
    .click();
  await expect(byUid.getByRole("status")).toContainText("Token unblocked.");
  await expect(byUid).toContainText(driver);
  await expect(byUid).toContainText("active (may charge)");
  await byUid.getByLabel("Whitelist").selectOption("NEVER");
  await byUid.getByRole("button", { name: "Set whitelist" }).click();
  await expect(byUid.getByRole("status")).toContainText("Whitelist changed.");
  await byUid.getByRole("button", { name: "Block token", exact: true }).click();
  await expect(byUid.getByRole("status")).toContainText("Token blocked.");
  await expect(byUid).toContainText("(may not charge)");
  await byUid.getByLabel("Token UID").fill("NO-SUCH-TOKEN");
  await byUid
    .getByRole("button", { name: "Unblock token", exact: true })
    .click();
  await expect(byUid.getByRole("alert")).toBeVisible();

  await page.getByRole("link", { name: "Find a driver" }).click();
  await expect(
    page.getByRole("heading", { name: "Drivers", level: 1 }),
  ).toBeVisible();
});

test("demo: Tokens shows only a sign-in prompt when nobody is signed in", async ({
  page,
}) => {
  await page.goto("/admin/tokens");
  await expect(
    page.getByRole("heading", { name: "Tokens", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Sign in as an admin to see tokens" }),
  ).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("link", { name: "Sign in" }),
  ).toHaveAttribute("href", "/admin/sign-in");
  await expect(page.getByLabel("Admin secret")).toHaveCount(0);
  await expect(page.getByLabel("Token UID")).toHaveCount(0);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `tokens, signed out, ${colorScheme}`);
  }
});

test("OCPI tokens endpoints refuse unknown tokens", async ({ request }) => {
  const headers = { Authorization: `Token ${btoa("unknown")}` };
  expect((await request.get("/ocpi/2.2.1/tokens", { headers })).status()).toBe(
    401,
  );
  const res = await request.post("/ocpi/2.2.1/tokens/ABC/authorize", {
    headers,
  });
  expect(res.status()).toBe(401);
  expect(await res.json()).toMatchObject({ status_code: 2000 });
});
