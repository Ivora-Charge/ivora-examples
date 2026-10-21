import { expect, test, type Page } from "@playwright/test";

// Demo mode: signed in as the labelled demo owner. Each test gets a fresh browser
// context, so a fresh sample team (it lives in the visitor's cookie).

async function openTeam(page: Page, isMobile: boolean) {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  if (isMobile) await nav.getByRole("button", { name: "Menu" }).click();
  await nav.getByRole("link", { name: /^Team/ }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Team" }),
  ).toBeVisible();
}

const staffList = (page: Page) => page.getByRole("list", { name: "Staff" });
const member = (page: Page, email: string) =>
  staffList(page).getByRole("listitem").filter({ hasText: email });

test("demo: signed in as the labelled demo owner, with the sample team", async ({
  page,
  isMobile,
}) => {
  await openTeam(page, isMobile);
  await expect(page.getByText("demo-owner@example.com · Owner")).toBeVisible();
  await expect(page.getByText("Sample", { exact: true }).first()).toBeVisible();
  for (const email of [
    "demo-owner@example.com",
    "sample-manager@example.com",
    "sample-technician@example.com",
    "sample-viewer@example.com",
  ])
    await expect(member(page, email)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Roles" })).toBeVisible();
});

test("demo: invite someone, open the link and join the team", async ({
  page,
  isMobile,
}) => {
  await openTeam(page, isMobile);
  await page.getByLabel("Email", { exact: true }).fill("new-tech@example.com");
  await page.getByLabel("Role", { exact: true }).selectOption("technician");
  await page.getByRole("button", { name: "Send invite" }).click();

  const preview = page.getByLabel("Email preview");
  await expect(preview).toContainText("To: new-tech@example.com");
  await expect(preview).toContainText("expires in 72 hours");
  await expect(page.getByText("Demo: no email was sent")).toBeVisible();
  const pending = page.getByRole("list", { name: "Pending invites" });
  await expect(pending).toContainText("new-tech@example.com");

  await page.getByRole("link", { name: "Open the invite link" }).click();
  await expect(
    page.getByRole("heading", { name: "Join the team" }),
  ).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveValue("new-tech@example.com");
  // The token is read from the fragment and removed from the address bar.
  await expect(page).toHaveURL(/\/invite$/);
  await page.getByLabel("Password").fill("a long demo password");
  await page.getByRole("button", { name: "Join the team" }).click();
  await expect(
    page.getByText("new-tech@example.com joined the team as Technician"),
  ).toBeVisible();

  await page.getByRole("link", { name: "See the team" }).click();
  await expect(member(page, "new-tech@example.com")).toContainText(
    "Technician",
  );
  await expect(page.getByRole("list", { name: "Pending invites" })).toHaveCount(
    0,
  );
});

test("demo: an invite link works once", async ({ page, isMobile }) => {
  await openTeam(page, isMobile);
  await page.getByLabel("Email", { exact: true }).fill("once@example.com");
  await page.getByRole("button", { name: "Send invite" }).click();
  const href = await page
    .getByRole("link", { name: "Open the invite link" })
    .getAttribute("href");
  await page.goto(href!);
  await page.getByLabel("Password").fill("a long demo password");
  await page.getByRole("button", { name: "Join the team" }).click();
  await expect(page.getByText("joined the team")).toBeVisible();
  await page.goto("/");
  await page.goto(href!);
  await expect(page.locator("main").getByRole("alert")).toContainText(
    "expired, was revoked or was already used",
  );
});

test("demo: change a role, remove someone and revoke an invite", async ({
  page,
  isMobile,
}) => {
  await openTeam(page, isMobile);
  const tech = member(page, "sample-technician@example.com");
  await tech
    .getByLabel("Role for sample-technician@example.com")
    .selectOption("viewer");
  await tech.getByRole("button", { name: "Change role" }).click();
  await expect(tech.getByText("Role changed to Viewer.")).toBeVisible();
  await expect(tech.locator(".role").first()).toHaveText("Viewer");

  page.once("dialog", (d) => d.accept());
  await member(page, "sample-viewer@example.com")
    .getByRole("button", { name: "Remove sample-viewer@example.com" })
    .click();
  await expect(member(page, "sample-viewer@example.com")).toHaveCount(0);

  await page.getByLabel("Email", { exact: true }).fill("revoke-me@example.com");
  await page.getByRole("button", { name: "Send invite" }).click();
  const pending = page.getByRole("list", { name: "Pending invites" });
  await expect(pending).toContainText("revoke-me@example.com");
  await pending
    .getByRole("button", { name: "Revoke invite for revoke-me@example.com" })
    .click();
  await expect(pending).toHaveCount(0);
});

test("demo: the last owner can't be demoted, and nobody can remove themselves", async ({
  page,
  isMobile,
}) => {
  await openTeam(page, isMobile);
  const me = member(page, "demo-owner@example.com");
  await expect(me.getByText("(you)")).toBeVisible();
  await expect(me.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  await me
    .getByLabel("Role for demo-owner@example.com")
    .selectOption("manager");
  await me.getByRole("button", { name: "Change role" }).click();
  await expect(me.getByRole("alert")).toHaveText(
    "The last owner can't be removed or demoted. Make someone else an owner first.",
  );
  await expect(me.locator(".role").first()).toHaveText("Owner");
});

test("demo: reset brings back the sample team", async ({ page, isMobile }) => {
  await openTeam(page, isMobile);
  page.once("dialog", (d) => d.accept());
  await member(page, "sample-viewer@example.com")
    .getByRole("button", { name: /^Remove/ })
    .click();
  await expect(member(page, "sample-viewer@example.com")).toHaveCount(0);
  await page.getByRole("button", { name: "Reset the demo team" }).click();
  await expect(member(page, "sample-viewer@example.com")).toBeVisible();
});

test("demo: sign-in and setup pages explain demo mode", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("note")).toContainText(
    "you are already signed in as the demo owner",
  );
  await page.goto("/setup");
  await expect(page.getByRole("note")).toContainText("nothing to set up");
  await page.goto("/invite");
  await expect(page.locator("main").getByRole("alert")).toContainText(
    "Open this page from the link in your invite email",
  );
});
