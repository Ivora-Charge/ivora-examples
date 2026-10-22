import { expect, test } from "@playwright/test";
import { E2E_ADMIN_SECRET } from "../playwright.config";

// Demo mode: tokens live in memory and nothing is pushed to a CPO.
test("demo: an admin looks up the sample driver, then issues and blocks an app token", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Drivers and tokens" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Drivers and tokens", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("nothing is pushed to a CPO")).toBeVisible();

  const lookup = page.getByRole("region", { name: "Look up a driver" });
  await lookup.getByLabel("Driver reference").fill("demo-driver");
  await lookup.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await lookup.getByRole("button", { name: "Show tokens" }).click();
  await expect(lookup.getByRole("status")).toContainText("2 token(s).");
  await expect(lookup.getByRole("status")).toContainText("ZZDMOCDEMO0001");

  // Unique per run: the server keeps demo tokens for as long as it runs.
  const driver = `e2e-${test.info().project.name}-${Date.now()}`;
  const create = page.getByRole("region", { name: "Create an app token" });
  await create.getByLabel("Driver reference").fill(driver);
  await create.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await create.getByRole("button", { name: "Create app token" }).click();
  const created = create.getByRole("status");
  await expect(created).toContainText("Demo mode: not pushed to any CPO.");
  const uid = (await created.locator("dd code").first().textContent())!;

  const change = page.getByRole("region", {
    name: "Block, unblock or change the whitelist",
  });
  await change.getByLabel("Token UID").fill(uid);
  await change.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await change.getByRole("button", { name: "Block", exact: true }).click();
  await expect(change.getByRole("status")).toContainText("Token blocked.");
  await expect(change.getByRole("status")).toContainText("(may not charge)");
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
