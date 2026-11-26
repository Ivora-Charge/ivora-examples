import { expect, test } from "@playwright/test";
import { expectAccessible, goTo, signIn } from "./support";

const schemes = ["light", "dark"] as const;

// Demo mode: accounts and tokens live in memory, and the only admin is the admin
// secret, which is sent no email. Email search is covered by unit tests.
test("demo: an admin finds the sample driver in the list and opens their page", async ({
  page,
}) => {
  await signIn(page);
  await goTo(page, "Drivers");
  await expect(
    page.getByRole("heading", { name: "Drivers", level: 1 }),
  ).toBeVisible();
  const table = page.getByRole("table", { name: "Drivers, newest first" });
  await expect(table).toContainText("demo-driver");
  const counts = page.getByRole("region", { name: "Driver counts" });
  await expect(counts).toContainText("Signed in, last 30 days");
  await expect(page.locator("main")).not.toContainText("@example.com");
  await expect(page.getByLabel("Email contains")).toHaveCount(0);
  await expect(page.getByLabel("Admin secret")).toHaveCount(0);
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `drivers, signed in, ${colorScheme}`);
  }

  const search = page.getByRole("form", { name: "Search drivers" });
  await search.getByLabel("Driver reference").fill("demo-driver");
  await search.getByRole("button", { name: "Search" }).click();
  await expect(page.locator(".foot [role=status]")).toContainText(
    /1 of 1 shown, newest first; 1 of \d+ account\(s\) match/,
  );
  // The search stays out of the address.
  expect(new URL(page.url()).search).toBe("");

  await table.getByRole("link", { name: "demo-driver" }).click();
  await expect(page).toHaveURL(/\/admin\/drivers\/demo-driver$/);
  const account = page.getByRole("region", { name: "Account" });
  await expect(account).toContainText("shown only to an admin signed in");
  await expect(account).toContainText("Card on file");
  // Blocking this driver is covered by unit tests: other e2e flows share them.
  await expect(
    account.getByRole("button", { name: "Block driver" }),
  ).toBeVisible();
  const tokens = page.getByRole("region", { name: "Tokens" });
  await expect(tokens).toContainText("2 token(s).");
  await expect(tokens).toContainText("ZZDMOCDEMO0001");
  await expect(
    page.getByRole("region", { name: "Last sessions" }),
  ).toBeVisible();
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `driver, signed in, ${colorScheme}`);
  }

  // The links lead to Payments and Sessions with the driver filled in.
  await page.getByRole("link", { name: "All payments of this driver" }).click();
  const payments = page.getByRole("region", { name: "A driver's payments" });
  await expect(payments.getByLabel("Driver reference")).toHaveValue(
    "demo-driver",
  );
  await expect(payments.getByRole("status")).toContainText(/payment/);
  await page.goBack();
  await page.getByRole("link", { name: "All sessions of this driver" }).click();
  await expect(
    page.getByRole("textbox", { name: "Driver reference" }),
  ).toHaveValue("demo-driver");
  await expect(
    page.getByRole("heading", { name: "No sessions match" }),
  ).toBeVisible();
});

test("demo: a reference without an account opens, gets a token and stays without an account", async ({
  page,
}) => {
  await signIn(page);
  await goTo(page, "Drivers");
  // Unique per run: the server keeps demo tokens for as long as it runs. A slash, a
  // question mark and a percent escape must come through the address unchanged.
  const driver = `e2e/%41?${test.info().project.name}-${Date.now()}`;
  const search = page.getByRole("form", { name: "Search drivers" });
  await search.getByLabel("Driver reference").fill(driver);
  await search.getByRole("button", { name: "Search" }).click();
  await expect(
    page.getByRole("heading", { name: "No account matches" }),
  ).toBeVisible();
  await page.getByRole("link", { name: `open the page of ${driver}` }).click();
  await expect(
    page.getByRole("heading", { name: `Driver ${driver}`, level: 1 }),
  ).toBeVisible();
  const account = page.getByRole("region", { name: "Account" });
  await expect(account).toContainText("No account yet");
  await expect(
    account.getByRole("button", { name: "Block driver" }),
  ).toHaveCount(0);

  const tokens = page.getByRole("region", { name: "Tokens" });
  await expect(tokens).toContainText("No tokens for this driver.");
  // No token yet, so the form to create one is open.
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
  await expect(account).toContainText("No account yet");
});

test("demo: Drivers and a driver's page show only a sign-in prompt when nobody is signed in", async ({
  page,
}) => {
  for (const [path, title, what] of [
    ["/admin/drivers", "Drivers", "drivers"],
    ["/admin/drivers/demo-driver", "Driver demo-driver", "this driver"],
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: title, level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: `Sign in as an admin to see ${what}` }),
    ).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.getByLabel("Driver reference")).toHaveCount(0);
    for (const colorScheme of schemes) {
      await page.emulateMedia({ colorScheme });
      await expectAccessible(page, `${what}, signed out, ${colorScheme}`);
    }
  }
});
