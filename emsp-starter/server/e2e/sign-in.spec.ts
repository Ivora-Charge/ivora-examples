import { expect, test } from "@playwright/test";
import { E2E_ADMIN_SECRET } from "../playwright.config";
import { expectAccessible, goTo, signIn } from "./support";

// Demo mode: no email is sent, the code is always 000000, and nobody is an admin.
const schemes = ["light", "dark"] as const;

test("demo: sign-in asks for the emailed code, not the link, and explains a missing code", async ({
  page,
}) => {
  await page.goto("/admin/sign-in");
  await expect(
    page.getByRole("heading", { name: "Sign in", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("no email is sent")).toBeVisible();
  // The secret is offered as a choice; no field for it until it is chosen.
  await expect(page.getByLabel("Admin secret")).toHaveCount(0);
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `sign-in, email, ${colorScheme}`);
  }

  const email = `admin-${test.info().project.name}@example.com`;
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(
    page.getByRole("heading", { name: "Type the code from the email" }),
  ).toBeVisible();
  await expect(
    page.getByText("Type the code. Do not click the link in the email."),
  ).toBeVisible();
  await page.getByText("The email has a link but no code").click();
  await expect(page.getByText("{{ .Token }}")).toBeVisible();
  await expect(page.getByText("Magic Link template")).toBeVisible();
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `sign-in, code, ${colorScheme}`);
  }

  // A right code for an address that is not on the admin list: both next steps, with
  // the first admin's statement for the address just used.
  await page.getByLabel("6-digit code").fill("000000");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Not on the admin list" }),
  ).toBeVisible();
  const alert = page.locator(".msg[role=alert]");
  await expect(alert).toContainText(`${email} is not an admin`);
  await expect(alert).toContainText("Ask an admin of this network to add you");
  await expect(page.getByLabel("SQL statement", { exact: true })).toContainText(
    `where email = '${email}'`,
  );
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `sign-in, not an admin, ${colorScheme}`);
  }
});

test("demo: too many codes says wait and try again, and that the newest code still works", async ({
  page,
}) => {
  const email = `limit-${test.info().project.name}@example.com`;
  await page.goto("/admin/sign-in");
  // This server sends at most 5 codes per address per hour: the sixth is refused.
  for (let i = 0; i < 6; i += 1) {
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Email me a code" }).click();
    if (i < 5)
      await page.getByRole("button", { name: "Use another email" }).click();
  }
  await expect(
    page.getByRole("heading", { name: "Too many sign-in attempts" }),
  ).toBeVisible();
  const alert = page.locator(".msg[role=alert]");
  await expect(alert).toContainText("Wait a while, then try again once.");
  await expect(alert).toContainText("Whose limit:");
  await expect(alert).toContainText(
    "the newest code still works until it expires",
  );
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `sign-in, limit, ${colorScheme}`);
  }
  await page
    .getByRole("button", { name: "Type a code I already have" })
    .click();
  await expect(page.getByLabel("6-digit code")).toBeVisible();
});

test("demo: the admin secret is asked once, kept for the tab only, and never stored", async ({
  page,
  context,
}) => {
  await signIn(page, "wrong");
  const alert = page.locator(".msg[role=alert]");
  await expect(alert).toContainText("That is not this server's admin secret.");
  await expect(alert).toContainText("wrong_secret");
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `sign-in, secret, ${colorScheme}`);
  }

  await page.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Account", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("In use for this tab")).toBeVisible();
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `account, ${colorScheme}`);
  }

  // Every admin page now opens its list without asking again.
  await goTo(page, "Peers");
  await expect(page.getByRole("list", { name: "Peers" })).toContainText(
    "Mock CPO (demo, built in)",
  );
  await expect(page.getByLabel("Admin secret")).toHaveCount(0);

  // Page memory only: nothing in storage or cookies, in the page's HTML or its URL.
  const stored = await page.evaluate(() =>
    JSON.stringify([
      { ...localStorage },
      { ...sessionStorage },
      document.cookie,
      location.href,
      document.documentElement.outerHTML,
    ]),
  );
  expect(stored).not.toContain(E2E_ADMIN_SECRET);
  expect(JSON.stringify(await context.cookies())).not.toContain(
    E2E_ADMIN_SECRET,
  );

  // A reload forgets it: the page is back to the sign-in prompt.
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Sign in as an admin to see your peers" }),
  ).toBeVisible();

  // So does "Forget the secret".
  await signIn(page);
  await page.getByRole("button", { name: "Forget the secret" }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in", level: 1 }),
  ).toBeVisible();
});
