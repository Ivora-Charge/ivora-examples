import { expect, test } from "@playwright/test";
import { E2E_ADMIN_SECRET } from "../playwright.config";
import { expectAccessible, goTo, signIn } from "./support";

// Demo mode: no email is sent, the code is always 000000, and nobody is an admin.
const schemes = ["light", "dark"] as const;

test("demo: sign-in asks for the emailed code, says the link works here too, and explains a missing code", async ({
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
    page.getByText("A link in the email signs you in too"),
  ).toBeVisible();
  // Another code for this address is possible once the server's cooldown is over.
  await expect(page.getByText(/New code possible in 0:[0-5]\d/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Email me a new code" }),
  ).toHaveCount(0);
  await page.getByText("The email has a link but no code").click();
  await expect(page.getByText("{{ .Token }}", { exact: true })).toBeVisible();
  await expect(
    page.getByText("{{ .RedirectTo }}?token_hash={{ .TokenHash }}"),
  ).toBeVisible();
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

test("demo: a second code too soon says whose limit it is and counts down the wait", async ({
  page,
}) => {
  const email = `limit-${test.info().project.name}@example.com`;
  await page.goto("/admin/sign-in");
  // This server sends one code per address a minute: asked again at once, it says so.
  for (let i = 0; i < 2; i += 1) {
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Email me a code" }).click();
    if (i < 1)
      await page.getByRole("button", { name: "Use another email" }).click();
  }
  await expect(
    page.getByRole("heading", { name: "A code was just sent to this address" }),
  ).toBeVisible();
  const alert = page.locator(".msg[role=alert]");
  await expect(alert).toContainText("You can ask again in");
  await expect(alert.locator(".big")).toHaveText(/^0:[0-5]\d$/);
  await expect(alert).toContainText("Whose limit: this server's.");
  await expect(alert).toContainText(
    "one code per email address every 60 seconds",
  );
  await expect(alert).toContainText(
    "the newest code still works until it expires",
  );
  await expect(alert).toContainText("sign_in_limited");
  // The clock runs.
  const first = await alert.locator(".big").textContent();
  await expect(alert.locator(".big")).not.toHaveText(first!, { timeout: 5000 });
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `sign-in, limit, ${colorScheme}`);
  }
  await page
    .getByRole("button", { name: "Type a code I already have" })
    .click();
  await expect(page.getByLabel("6-digit code")).toBeVisible();
  // The same wait holds the button that asks for a new code.
  await expect(page.getByText(/New code possible in 0:[0-5]\d/)).toBeVisible();
});

test("demo: the emailed link opens a button, never signs in by itself, and a refused link leaves the address bar", async ({
  page,
  context,
}) => {
  await page.goto("/admin/sign-in?token_hash=hash0123456789abcdef");
  await expect(
    page.getByRole("heading", { name: "Sign in with the link from the email" }),
  ).toBeVisible();
  await expect(
    page.getByText("Opening the link alone signs nobody in"),
  ).toBeVisible();
  expect(await context.cookies()).toEqual([]);
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `sign-in, link, ${colorScheme}`);
  }
  // Demo mode sends no email, so no link is a real one: the page says so and goes
  // back to asking for an email.
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const alert = page.locator(".msg[role=alert]");
  await expect(alert).toContainText(
    "This sign-in link is invalid or has expired.",
  );
  await expect(alert).toContainText("Ask for a new email below");
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/sign-in$/);
  expect(await context.cookies()).toEqual([]);

  // A token hash that is not one is not shown as a link at all.
  await page.goto("/admin/sign-in?token_hash=nope");
  await expect(
    page.getByRole("heading", { name: "Sign in", level: 1 }),
  ).toBeVisible();
});

test("demo: the admin secret is asked once and exchanged for a session cookie that scripts cannot read", async ({
  page,
  context,
}) => {
  await signIn(page, "wrong");
  const alert = page.locator(".msg[role=alert]");
  await expect(alert).toContainText("That is not this server's admin secret.");
  await expect(alert).toContainText("wrong_secret");
  expect(await context.cookies()).toEqual([]);
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `sign-in, secret, ${colorScheme}`);
  }

  await page.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Account", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Session in use")).toBeVisible();
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `account, ${colorScheme}`);
  }

  // One cookie: httpOnly, SameSite=Strict, Secure (a production build), for an hour.
  const cookies = await context.cookies();
  expect(cookies.map((c) => c.name)).toEqual(["emsp_admin_secret"]);
  const [cookie] = cookies;
  expect(cookie).toMatchObject({
    httpOnly: true,
    sameSite: "Strict",
    secure: true,
    path: "/",
  });
  const life = cookie.expires - Date.now() / 1000;
  expect(life).toBeGreaterThan(55 * 60);
  expect(life).toBeLessThanOrEqual(60 * 60 + 5);

  // Every admin page now opens its list without asking again.
  await goTo(page, "Peers");
  await expect(page.getByRole("list", { name: "Peers" })).toContainText(
    "Mock CPO (demo, built in)",
  );
  await expect(page.getByLabel("Admin secret")).toHaveCount(0);

  // The secret is nowhere in the browser: not in storage, the cookie, the page or
  // its URL. Page scripts cannot see the session cookie either.
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
  expect(stored).not.toContain(cookie.value);
  expect(JSON.stringify(cookies)).not.toContain(E2E_ADMIN_SECRET);
  expect(await page.evaluate(() => document.cookie)).toBe("");

  // A reload keeps the session: the list opens by itself again.
  await page.reload();
  await expect(page.getByRole("list", { name: "Peers" })).toContainText(
    "Mock CPO (demo, built in)",
  );

  // Signing out drops the cookie, and the pages are back to the sign-in prompt.
  await goTo(page, "Account");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in", level: 1 }),
  ).toBeVisible();
  expect(await context.cookies()).toEqual([]);
  await page.goto("/admin/peers");
  await expect(
    page.getByRole("region", { name: "Sign in as an admin to see your peers" }),
  ).toBeVisible();
});
