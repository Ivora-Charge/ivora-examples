import { expect, test } from "@playwright/test";
import { expectAccessible, goTo, signIn } from "./support";

// Demo mode: a driver reports a problem from the app (its API), and an admin reads it.
const LOC1 = Buffer.from(
  JSON.stringify(["demo-mock-cpo", "ZZ", "MCK", "LOC1"]),
).toString("base64url");

test("demo: a driver's report reaches the admin web, which marks it resolved", async ({
  page,
  request,
}) => {
  const email = `reporter-${test.info().project.name}@example.com`;
  await request.post("/api/v1/auth/code", { data: { email } });
  const signedIn = await request.post("/api/v1/auth/verify", {
    data: { email, code: "000000" },
  });
  const token = (await signedIn.json()).session.accessToken as string;
  const message = `The cable is cut (${test.info().project.name}, ${Date.now()}).`;
  const sent = await request.post("/api/v1/problems", {
    headers: { Authorization: `Bearer ${token}` },
    data: { locationId: LOC1, evseUid: "LOC1-1", category: "damaged", message },
  });
  expect(sent.status()).toBe(201);
  const { id } = await sent.json();

  await signIn(page);
  await goTo(page, "Problems");
  await expect(
    page.getByRole("heading", { name: "Problems", level: 1 }),
  ).toBeVisible();
  await expect(page.getByLabel("Admin secret")).toHaveCount(0);

  // The list of open reports opens by itself: nothing to press first.
  const show = page.getByRole("group", { name: "Show" });
  await expect(show.getByRole("button", { name: "Open" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const row = page.getByRole("row").filter({ hasText: message });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Damaged");
  await expect(row).toContainText("Open");

  // The report is a row with its own actions: no ID is copied anywhere.
  await row.getByRole("button", { name: /^Show report/ }).click();
  await expect(page.getByText("The driver sent no photo.")).toBeVisible();
  await expect(
    page.getByRole("definition").filter({ hasText: id }),
  ).toBeVisible();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `problems, signed in, ${colorScheme}`);
  }
  await row.getByRole("button", { name: /^Hide report/ }).click();

  await row.getByRole("button", { name: /^Mark resolved/ }).click();
  await expect(page.getByRole("status").filter({ hasText: id })).toContainText(
    "is resolved",
  );
  await expect(page.getByRole("row").filter({ hasText: message })).toHaveCount(
    0,
  );

  await show.getByRole("button", { name: "Resolved" }).click();
  const resolved = page.getByRole("row").filter({ hasText: message });
  await expect(resolved).toContainText("Resolved");
  await expect(
    resolved.getByRole("button", { name: /^Mark resolved/ }),
  ).toHaveCount(0);
});

test("demo: Problems shows only a sign-in prompt when nobody is signed in", async ({
  page,
}) => {
  await page.goto("/admin/problems");
  await expect(
    page.getByRole("heading", { name: "Problems", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Sign in as an admin to see reported problems",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("link", { name: "Sign in" }),
  ).toHaveAttribute("href", "/admin/sign-in");
  await expect(page.getByLabel("Admin secret")).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `problems, signed out, ${colorScheme}`);
  }
});
