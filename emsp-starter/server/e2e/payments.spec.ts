import { expect, test } from "@playwright/test";
import { expectAccessible, goTo, signIn } from "./support";

// Demo mode: payments live in memory and nothing is sent to Stripe.
test("demo: Payments shows only a sign-in prompt until an admin signs in", async ({
  page,
}) => {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto("/admin/payments");
    await expect(
      page.getByRole("heading", { name: "Payments", level: 1 }),
    ).toBeVisible();
    const gate = page.getByRole("region", {
      name: "Sign in as an admin to see payments",
    });
    await expect(gate.getByRole("link", { name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Admin secret")).toHaveCount(0);
    await expect(page.getByLabel("Payment or charge ID")).toHaveCount(0);
    await expectAccessible(page, `payments, signed out, ${colorScheme}`);
  }
});

test("demo: the review list opens by itself, and a payment is found by its ID", async ({
  page,
}) => {
  await signIn(page);
  await goTo(page, "Payments");
  await expect(
    page.getByRole("heading", { name: "Payments", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByText("no card is charged and nothing is sent to Stripe"),
  ).toBeVisible();
  await expect(page.getByLabel("Admin secret")).toHaveCount(0);

  // Nothing to press first: the list is the page.
  const review = page.getByRole("region", { name: "To review" });
  await expect(review.getByRole("status")).toContainText("Nothing to review.");

  const find = page.getByRole("region", { name: "Find a payment" });
  await find
    .getByLabel("Payment or charge ID")
    .fill("00000000-0000-0000-0000-000000000000");
  await find.getByRole("button", { name: "Find payment" }).click();
  const alert = find.getByRole("alert");
  await expect(alert).toContainText("No such payment.");
  await expect(alert).toContainText("not_found");
  await expect(alert).toContainText("Next step");

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `payments, signed in, ${colorScheme}`);
  }
});
