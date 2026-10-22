import { expect, test } from "@playwright/test";
import { E2E_ADMIN_SECRET } from "../playwright.config";

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
  const message = `The cable is cut (${test.info().project.name}).`;
  const sent = await request.post("/api/v1/problems", {
    headers: { Authorization: `Bearer ${token}` },
    data: { locationId: LOC1, evseUid: "LOC1-1", category: "damaged", message },
  });
  expect(sent.status()).toBe(201);
  const { id } = await sent.json();

  await page.goto("/");
  await page.getByRole("link", { name: "Problems" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Reported problems", level: 1 }),
  ).toBeVisible();
  const list = page.getByRole("region", { name: "Reported problems" });
  await list.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await list.getByRole("button", { name: "Show reports" }).click();
  await expect(list.getByRole("cell", { name: message })).toBeVisible();

  const resolve = page.getByRole("region", { name: "Mark a report resolved" });
  await resolve.getByLabel("Report ID").fill(id);
  await resolve.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await resolve.getByRole("button", { name: "Mark resolved" }).click();
  await expect(resolve.getByRole("status")).toContainText("is resolved");
});
