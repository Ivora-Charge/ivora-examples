import { expect, test } from "@playwright/test";
import { E2E_ADMIN_SECRET } from "../playwright.config";

// Demo mode: peers live in memory and nothing is sent to a CPO.
test("demo: an admin invites a CPO and gets a Token A once", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "CPO peers" }).first().click();
  await expect(page.getByRole("heading", { name: "CPO peers" })).toBeVisible();
  await expect(page.getByText("peers are kept in memory only")).toBeVisible();

  const invite = page.getByRole("region", {
    name: "Let a CPO register with us",
  });
  await invite.getByLabel("Name").fill("Example CPO");
  await invite.getByLabel("Admin secret").fill("wrong");
  await invite.getByRole("button", { name: "Create Token A" }).click();
  await expect(invite.getByRole("alert")).toHaveText("Wrong admin secret.");

  await invite.getByLabel("Name").fill("Example CPO");
  await invite.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await invite.getByRole("button", { name: "Create Token A" }).click();
  const result = invite.getByRole("status");
  await expect(result).toContainText("shown only once");
  await expect(result).toContainText("/ocpi/versions");
  await expect(result).toContainText("pending");
});

test("demo: registering at a CPO is refused, nothing sent", async ({
  page,
}) => {
  await page.goto("/admin/peers");
  const connect = page.getByRole("region", { name: "Connect to a CPO" });
  await connect.getByLabel("Name").fill("Example CPO");
  await connect
    .getByLabel("CPO versions URL")
    .fill("https://cpo.example.com/ocpi/versions");
  await connect.getByLabel("Token A").fill("token-a");
  await connect.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await connect.getByRole("button", { name: "Register at the CPO" }).click();
  await expect(connect.getByRole("alert")).toHaveText(
    "Demo mode: refused to register at a CPO. Nothing was sent.",
  );
});

test("OCPI versions endpoint refuses unknown tokens", async ({ request }) => {
  const res = await request.get("/ocpi/versions", {
    headers: { Authorization: `Token ${btoa("unknown")}` },
  });
  expect(res.status()).toBe(401);
  expect(await res.json()).toMatchObject({ status_code: 2000 });
});
