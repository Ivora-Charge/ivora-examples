import { expect, test } from "@playwright/test";
import { E2E_ADMIN_SECRET } from "../playwright.config";

// Demo mode: the mock CPO's sample sessions and CDRs, in memory. Nothing leaves.
test("demo: an admin lists live and recent sessions with filters", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Sessions" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Sessions", level: 1 }),
  ).toBeVisible();

  const list = page.getByRole("region", { name: "Live and recent sessions" });
  await list.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await list.getByRole("button", { name: "Show sessions" }).click();
  await expect(list.getByRole("status")).toContainText("1 session(s)");
  await expect(list.getByRole("cell", { name: "ACTIVE" })).toBeVisible();

  await list.getByLabel("Status").selectOption("all");
  await list.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await list.getByRole("button", { name: "Show sessions" }).click();
  await expect(list.getByRole("status")).toContainText("3 session(s)");

  // The form keeps the filters of the last list; "Started before" takes a timestamp.
  await expect(list.getByLabel("Status")).toHaveValue("all");
  await list
    .getByLabel("Started before (optional)")
    .fill("2000-01-01T00:00:00Z");
  await list.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await list.getByRole("button", { name: "Show sessions" }).click();
  await expect(list.getByRole("status")).toContainText("No sessions match.");
  await expect(list.getByLabel("Started before (optional)")).toHaveValue(
    "2000-01-01T00:00:00.000Z",
  );
  await list.getByLabel("Started before (optional)").fill("");

  await list.getByLabel("Peer ID (optional)").fill("not a peer");
  await list.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await list.getByRole("button", { name: "Show sessions" }).click();
  const alert = list.getByRole("alert");
  await expect(alert).toContainText("Peer ID must be a UUID.");
  await expect(alert).toContainText("invalid_input");
  await expect(alert).toContainText("Next step");
});

test("demo: an admin reconciles CDRs per peer and gets a CSV", async ({
  page,
}) => {
  await page.goto("/admin/reconciliation");
  await expect(
    page.getByRole("heading", { name: "CDR reconciliation", level: 1 }),
  ).toBeVisible();
  const card = page.getByRole("region", { name: "Reconcile" });
  await card.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await card.getByRole("button", { name: "Reconcile" }).click();
  await expect(card.getByRole("status")).toContainText("mismatch(es)");
  await expect(card.getByRole("region", { name: "Mismatches" })).toContainText(
    "Completed sessions without a CDR",
  );

  const download = page.waitForEvent("download");
  await card.getByRole("link", { name: "Download CSV" }).click();
  expect((await download).suggestedFilename()).toMatch(
    /^reconciliation_all_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/,
  );
});

test("demo: peer status shows the mock CPO; demo pulls explain themselves", async ({
  page,
}) => {
  await page.goto("/admin/peers");
  const list = page.getByRole("region", { name: "Peers and their status" });
  await list.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await list.getByRole("button", { name: "Show peers" }).click();
  await expect(list.getByRole("status")).toContainText("peer(s)");
  await expect(list).toContainText("Mock CPO (demo, built in)");

  const sync = page.getByRole("region", {
    name: "Pull locations and tariffs",
  });
  await sync.getByLabel("Peer ID").fill("00000000-0000-4000-8000-000000000000");
  await sync.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await sync.getByRole("button", { name: "Pull changes" }).click();
  await expect(sync.getByRole("alert")).toContainText("demo_mode");
});

test("demo: refunds need a reason and have an audit log; drivers can be looked up", async ({
  page,
}) => {
  await page.goto("/admin/payments");
  await expect(
    page.getByRole("heading", { name: "Payments and refunds", level: 1 }),
  ).toBeVisible();
  const audit = page.getByRole("region", { name: "Audit log of a payment" });
  await audit
    .getByLabel("Payment or charge ID")
    .fill("00000000-0000-0000-0000-000000000000");
  await audit.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await audit.getByRole("button", { name: "Show audit log" }).click();
  await expect(audit.getByRole("alert")).toContainText("No such payment.");
  await expect(audit.getByRole("alert")).toContainText("not_found");
  await expect(
    page.getByRole("region", { name: "Refund" }).getByLabel("Reason"),
  ).toHaveAttribute("required", "");

  await page.goto("/admin/tokens");
  const driver = page.getByRole("region", {
    name: "Block or unblock a driver",
  });
  await driver.getByLabel("Driver reference").fill("demo-driver");
  await driver.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  // Blocking is covered by unit tests: the demo driver is shared by other e2e flows.
  await driver.getByRole("button", { name: "Show driver" }).click();
  await expect(driver.getByRole("status")).toContainText("Driver found.");
  await expect(driver).toContainText("active (may charge)");
});

test("demo: a wide table says when it scrolls, and then takes focus", async ({
  page,
  isMobile,
}) => {
  await page.goto("/admin/sessions");
  const list = page.getByRole("region", { name: "Live and recent sessions" });
  await list.getByLabel("Status").selectOption("all");
  await list.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await list.getByRole("button", { name: "Show sessions" }).click();
  const table = list.getByRole("region", { name: "Sessions table" });
  await expect(table.getByRole("table")).toBeVisible();
  const hint = list.getByText("Scroll sideways for more columns");
  if (isMobile) {
    await expect(hint).toBeVisible();
    await expect(table).toHaveAttribute("tabindex", "0");
  }
  // The hint and the tab stop show exactly when the table is wider than its card.
  const scrolls = await table.evaluate((el) => el.scrollWidth > el.clientWidth);
  await expect(hint).toHaveCount(scrolls ? 1 : 0);
  if (!scrolls) await expect(table).not.toHaveAttribute("tabindex");
});
