import { expect, test } from "@playwright/test";
import { E2E_ADMIN_SECRET } from "../playwright.config";

// Demo mode: adapters stay in memory and are never called.
test("demo: an admin gives a peer the Ivora adapter, the key is never shown", async ({
  page,
}) => {
  await page.goto("/admin/peers");
  const invite = page.getByRole("region", {
    name: "Let a CPO register with us",
  });
  await invite.getByLabel("Name").fill("Example CPO");
  await invite.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await invite.getByRole("button", { name: "Create Token A" }).click();
  await expect(invite.getByRole("status")).toContainText("pending");
  const peerId =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(
      (await invite.getByRole("status").textContent()) ?? "",
    )?.[0];
  expect(peerId).toBeTruthy();

  await page.getByRole("link", { name: "live-data adapter" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Live data" }),
  ).toBeVisible();
  await expect(page.getByText("never called")).toBeVisible();

  const key = "iv_live_e2e-only-read-key-0123456789";
  const ivora = page.getByRole("region", {
    name: "Read live data from the Ivora API",
  });
  // The form clears after each submit, so every attempt fills it again.
  const save = async (secret: string) => {
    await ivora.getByLabel("Peer ID").fill(peerId!);
    await ivora.getByLabel("Tenant ID").fill("42");
    await ivora.getByLabel("Read-only API key").fill(key);
    await ivora.getByLabel("Admin secret").fill(secret);
    await ivora.getByRole("button", { name: "Save adapter" }).click();
  };
  await save("wrong");
  await expect(ivora.getByRole("alert")).toContainText("Wrong admin secret.");

  await save(E2E_ADMIN_SECRET);
  const result = ivora.getByRole("status");
  await expect(result).toContainText("now uses the Ivora API adapter");
  await expect(result).toContainText("Stored encrypted");
  await expect(page.getByText(key)).toHaveCount(0);
});
