import { expect, test } from "@playwright/test";
import { expectAccessible, goTo, signIn } from "./support";

// Demo mode: adapters stay in memory and are never called.
test("demo: an admin gives a peer the Ivora adapter from the peer's page, the key is never shown", async ({
  page,
}) => {
  const name = `Live data CPO ${test.info().project.name} ${Date.now()}`;
  await signIn(page);
  await goTo(page, "Peers");
  await page.getByRole("link", { name: "Connect a peer" }).click();
  await page
    .getByRole("button", { name: /They will register with us/ })
    .click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create the one-time token" }).click();
  await page.getByRole("link", { name: "See peers" }).click();
  await page
    .getByRole("list", { name: "Peers" })
    .getByRole("link", { name: new RegExp(name) })
    .click();

  const live = page.getByRole("region", { name: "Live data" });
  await expect(live).toContainText("No adapter");
  const key = "iv_live_e2e-only-read-key-0123456789";
  await live.getByText("Read live data from the Ivora API").click();
  await live.getByLabel("Tenant ID").fill("42");
  await live.getByLabel("Read-only API key").fill(key);
  await live.getByRole("button", { name: "Save adapter" }).click();
  await expect(live.getByRole("status").first()).toContainText(
    "now uses the Ivora API adapter",
  );
  await expect(live).toContainText("Stored encrypted");
  await expect(live.getByLabel("Read-only API key")).toHaveValue("");
  await expect(page.getByText(key)).toHaveCount(0);

  // Every adapter is also listed on Peers, with a link back to its peer.
  await goTo(page, "Peers");
  const adapters = page.getByRole("region", { name: "Live-data adapters" });
  const listed = adapters.getByRole("row").filter({ hasText: name });
  await expect(listed).toContainText("Ivora");
  await expect(listed).toContainText("Stored encrypted");
  await expect(page.getByText(key)).toHaveCount(0);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `peers, with an adapter, ${colorScheme}`);
  }
  await listed.getByRole("link", { name }).click();
  await expect(live).toContainText("Stored encrypted");

  await live.getByRole("button", { name: "Remove adapter" }).click();
  await live.getByRole("button", { name: "Yes, remove" }).click();
  await expect(live).toContainText("Adapter removed.");
  await expect(live).toContainText("No adapter");
});

test("the old live-data address leads to Peers", async ({ page }) => {
  await page.goto("/admin/live-data");
  await expect(page).toHaveURL(/\/admin\/peers#live-data$/);
  await expect(
    page.getByRole("heading", { name: "Peers", level: 1 }),
  ).toBeVisible();
});
