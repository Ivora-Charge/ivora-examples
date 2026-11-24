import { expect, test } from "@playwright/test";
import { expectAccessible, goTo, signIn } from "./support";

const schemes = ["light", "dark"] as const;

// Demo mode: the mock CPO's sample sessions, in memory. Nothing leaves.
test("demo: Sessions shows only a sign-in prompt until an admin signs in", async ({
  page,
}) => {
  await page.goto("/admin/sessions");
  await expect(
    page.getByRole("heading", { name: "Sessions", level: 1 }),
  ).toBeVisible();
  const gate = page.getByRole("region", {
    name: "Sign in as an admin to see sessions",
  });
  await expect(gate.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Admin secret")).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `sessions, signed out, ${colorScheme}`);
  }
});

test("demo: the session list opens by itself; filters are chips; a table on desktop, cards on a phone", async ({
  page,
  isMobile,
}) => {
  await signIn(page);
  await goTo(page, "Sessions");
  const chips = page.getByRole("group", { name: "Show" });
  await expect(chips.getByRole("button", { name: "All" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const table = page.getByRole("table", { name: "Sessions, newest first" });
  const rows = table.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("Mock CPO (demo)");
  // No counts or search the server does not give.
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(chips).not.toContainText(/\d/);

  // The same markup: column headers on a wide screen, one card per row on a phone.
  const header = table.getByRole("columnheader", { name: "Peer" });
  const display = (l: ReturnType<typeof page.locator>) =>
    l.evaluate((el) => getComputedStyle(el).display);
  if (isMobile) {
    expect(await display(rows.first())).toBe("grid");
    expect(
      await table
        .locator("thead")
        .evaluate((el) => el.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(1);
  } else {
    expect(await display(rows.first())).toBe("table-row");
    await expect(header).toBeVisible();
  }
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `sessions, list, ${colorScheme}`);
  }

  await chips.getByRole("button", { name: "Charging now" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Charging");

  // The other filters the server has today, behind one line.
  await page.getByText("More filters").click();
  await page.getByLabel("Started before").fill("2000-01-01T00:00:00Z");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(
    page.getByRole("heading", { name: "No sessions match" }),
  ).toBeVisible();
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `sessions, empty, ${colorScheme}`);
  }

  await page.getByLabel("Started before").fill("yesterday");
  await page.getByRole("button", { name: "Apply filters" }).click();
  const alert = page.locator(".msg[role=alert]");
  await expect(alert).toContainText("Started before must be a UTC day");
  await expect(alert).toContainText("invalid_input");
  await expect(alert).toContainText("Next step");

  await page.getByRole("button", { name: "Clear all filters" }).click();
  await expect(rows).toHaveCount(3);
});

test("OCPI sessions and CDRs endpoints refuse unknown tokens", async ({
  request,
}) => {
  const headers = { Authorization: `Token ${btoa("unknown")}` };
  for (const res of [
    await request.put("/ocpi/2.2.1/sessions/ZZ/MCK/SESSION-1", {
      headers,
      data: {},
    }),
    await request.patch("/ocpi/2.2.1/sessions/ZZ/MCK/SESSION-1", {
      headers,
      data: { last_updated: "2026-10-21T10:00:00Z" },
    }),
    await request.post("/ocpi/2.2.1/cdrs", { headers, data: {} }),
    await request.get("/ocpi/2.2.1/cdrs/00000000-0000-4000-8000-000000000000", {
      headers,
    }),
  ]) {
    expect(res.status()).toBe(401);
    expect(await res.json()).toMatchObject({ status_code: 2000 });
  }
});
