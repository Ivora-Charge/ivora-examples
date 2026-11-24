import { expect, test } from "@playwright/test";
import { expectAccessible, goTo, signIn } from "./support";

// Demo mode: the mock CPO's sample sessions and CDRs, in memory. Nothing leaves.
test("demo: Reconciliation shows only a sign-in prompt until an admin signs in", async ({
  page,
}) => {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto("/admin/reconciliation");
    await expect(
      page.getByRole("heading", { name: "Reconciliation", level: 1 }),
    ).toBeVisible();
    const gate = page.getByRole("region", {
      name: "Sign in as an admin to reconcile CDRs",
    });
    await expect(gate.getByRole("link", { name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Admin secret")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reconcile" })).toHaveCount(
      0,
    );
    await expectAccessible(page, `reconciliation, signed out, ${colorScheme}`);
  }
});

test("demo: an admin reconciles CDRs per peer and gets a CSV", async ({
  page,
}) => {
  await signIn(page);
  await goTo(page, "Reconciliation");
  await expect(
    page.getByRole("heading", { name: "Reconciliation", level: 1 }),
  ).toBeVisible();
  await expect(page.getByLabel("Admin secret")).toHaveCount(0);

  // It runs by itself with the days of the sample sessions.
  await expect(
    page.getByRole("status").filter({ hasText: "mismatch(es)" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Mismatches" })).toContainText(
    "Completed sessions without a CDR",
  );
  await expect(
    page.getByRole("region", {
      name: "Per peer, over the days",
      exact: true,
    }),
  ).toContainText("Mock CPO (demo)");

  // The peer is chosen by name, and the same days run again.
  const form = page.getByRole("form", { name: "Days and peer" });
  await expect(form.getByLabel("Peer")).toContainText("Mock CPO");
  await form.getByRole("button", { name: "Reconcile" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "mismatch(es)" }),
  ).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download CSV" }).click();
  expect((await download).suggestedFilename()).toMatch(
    /^reconciliation_all_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/,
  );

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `reconciliation, signed in, ${colorScheme}`);
  }
});
