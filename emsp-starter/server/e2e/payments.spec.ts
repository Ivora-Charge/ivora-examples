import { expect, test } from "@playwright/test";
import { E2E_ADMIN_SECRET } from "../playwright.config";

// Demo mode: payments live in memory and nothing is sent to Stripe.
test("demo: an admin opens payments and the review list, and sees the sign-in page", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Payments" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Payments", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByText("no card is charged and nothing is sent to Stripe"),
  ).toBeVisible();

  const review = page.getByRole("region", { name: "Payments to review" });
  await review.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await review.getByRole("button", { name: "Show payments to review" }).click();
  await expect(review.getByRole("status")).toContainText("Nothing to review.");

  const lookup = page.getByRole("region", { name: "Look up a payment" });
  await lookup
    .getByLabel("Payment or charge ID")
    .fill("00000000-0000-0000-0000-000000000000");
  await lookup.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await lookup.getByRole("button", { name: "Show payment" }).click();
  await expect(lookup.getByRole("alert")).toContainText("No such payment.");

  await page.getByRole("link", { name: "Sign in" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Admin sign-in", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("no email is sent")).toBeVisible();
});
