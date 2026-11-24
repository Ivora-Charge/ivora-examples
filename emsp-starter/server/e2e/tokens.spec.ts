import { expect, test } from "@playwright/test";
import { expectAccessible, goTo, signIn } from "./support";

// Demo mode: tokens live in memory and nothing is pushed to a CPO.
test("demo: an admin finds the sample driver, then issues and blocks an app token", async ({
  page,
}) => {
  await signIn(page);
  await goTo(page, "Drivers and tokens");
  await expect(
    page.getByRole("heading", { name: "Drivers and tokens", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("nothing is pushed to a CPO")).toBeVisible();
  await expect(page.getByLabel("Admin secret")).toHaveCount(0);

  const find = page.getByRole("region", { name: "Find a driver" });
  await find.getByLabel("Driver reference").fill("demo-driver");
  await find.getByRole("button", { name: "Find driver" }).click();

  // The driver is a thing with its own actions: the account, then its tokens.
  const account = page.getByRole("region", { name: "Driver demo-driver" });
  await expect(account.getByRole("status")).toContainText("Driver found.");
  await expect(account).toContainText("active (may charge)");
  // Blocking the driver is covered by unit tests: other e2e flows share this driver.
  await expect(
    account.getByRole("button", { name: "Block driver" }),
  ).toBeVisible();

  const tokens = page.getByRole("region", { name: "Tokens" });
  await expect(tokens).toContainText("2 token(s).");
  await expect(tokens).toContainText("ZZDMOCDEMO0001");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `drivers, signed in, ${colorScheme}`);
  }

  // Unique per run: the server keeps demo tokens for as long as it runs.
  const driver = `e2e-${test.info().project.name}-${Date.now()}`;
  await find.getByLabel("Driver reference").fill(driver);
  await find.getByRole("button", { name: "Find driver" }).click();
  const unknown = page.getByRole("region", { name: `Driver ${driver}` });
  await expect(unknown.getByRole("alert")).toContainText(
    "No such driver account.",
  );
  await expect(unknown.getByRole("alert")).toContainText("not_found");
  await expect(tokens).toContainText("No tokens for this driver.");

  // No token yet, so the form to create one is open, with the driver filled in.
  const create = tokens.getByRole("form", { name: "Create an app token" });
  await create.getByRole("button", { name: "Create app token" }).click();
  await expect(tokens).toContainText(
    "App token created. Demo mode: not pushed to any CPO.",
  );
  const item = tokens.getByRole("listitem").filter({ hasText: "App token" });
  await expect(item).toContainText("active (may charge)");

  // Block it from its own row; the first press asks, the second does it.
  await item.getByRole("button", { name: /^Block / }).click();
  await item.getByRole("button", { name: "Yes, block" }).click();
  await expect(tokens).toContainText("Token blocked.");
  await expect(item).toContainText("(may not charge)");
});

test("demo: Drivers and tokens shows only a sign-in prompt when nobody is signed in", async ({
  page,
}) => {
  await page.goto("/admin/tokens");
  await expect(
    page.getByRole("heading", { name: "Drivers and tokens", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Sign in as an admin to see drivers and tokens",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("link", { name: "Sign in" }),
  ).toHaveAttribute("href", "/admin/sign-in");
  await expect(page.getByLabel("Admin secret")).toHaveCount(0);
  await expect(page.getByLabel("Driver reference")).toHaveCount(0);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `drivers, signed out, ${colorScheme}`);
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
