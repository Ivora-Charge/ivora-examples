import { expect, test, type Page } from "@playwright/test";

// Demo mode: signed in as the labelled demo owner. Roaming settings live in the
// visitor's cookie, so each test starts with publishing off and no party requested.
// Nothing is sent to Ivora; the party decision is played by demo-only buttons.

async function openRoaming(page: Page, isMobile: boolean) {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  if (isMobile) await nav.getByRole("button", { name: "Menu" }).click();
  await nav.getByRole("link", { name: /^Settings/ }).click();
  await page.getByRole("link", { name: "Roaming settings" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: /Roaming/ }),
  ).toBeVisible();
}

test("demo: publish sites, request a party ID and see Ivora's approval", async ({
  page,
  isMobile,
}) => {
  await openRoaming(page, isMobile);
  await expect(
    page.getByRole("heading", { name: "Roaming placeholder (OCPI)" }),
  ).toBeVisible();
  await expect(page.getByText("separate add-on")).toBeVisible();
  const status = page.getByRole("region", { name: /Publishing/ });
  await expect(status).toContainText("Not published");
  await expect(status).toContainText("Publishing is off.");

  const publish = page.getByLabel("Publish my sites to roaming partners");
  await expect(publish).not.toBeChecked();
  await publish.check();
  await page.getByLabel("Operator name").fill("Sample Charging Co");
  await page
    .getByLabel("Website (optional)")
    .fill("https://charge.example.com");
  await page.getByLabel("Time zone (optional)").selectOption("America/Chicago");
  await page.getByLabel("Sample Site: Market Street").uncheck();
  await page.getByLabel("Country code").fill("us");
  await page.getByRole("textbox", { name: "Party ID" }).fill("smp");
  await page.getByRole("button", { name: "Save roaming settings" }).click();

  await expect(page.locator("main").getByRole("status")).toContainText(
    "Roaming settings saved. Demo: nothing was sent to Ivora.",
  );
  await expect(page.locator("main").getByRole("status")).toContainText(
    "Party US*SMP is waiting for Ivora's approval",
  );
  await expect(status).toContainText("Demo: would be published");
  await expect(status).toContainText("partners would receive your sites");
  const party = page.getByRole("region", { name: "Party ID request" });
  await expect(party).toContainText("Waiting for Ivora");
  await expect(party).toContainText("shared party US*IVR");

  // The saved values come back, and the unticked site stays unpublished.
  await page.reload();
  await expect(publish).toBeChecked();
  await expect(page.getByLabel("Operator name")).toHaveValue(
    "Sample Charging Co",
  );
  await expect(page.getByLabel("Sample Site: Market Street")).not.toBeChecked();
  await expect(page.getByLabel("Sample Site: Harbour Car Park")).toBeChecked();
  await expect(page.getByRole("textbox", { name: "Party ID" })).toHaveValue(
    "SMP",
  );

  await party.getByRole("button", { name: "Demo: Ivora approves" }).click();
  await expect(party).toContainText("Approved");
  await expect(party).toContainText("Partners see your sites under it.");
  const evse = page.getByRole("table", { name: "Imported EVSE IDs" });
  await expect(evse).toContainText("US*SMP*EDEMO01");
  await expect(evse).toContainText("DEMO-HARBOUR-01");

  await page
    .getByRole("button", { name: "Demo: reset roaming settings" })
    .click();
  await expect(publish).not.toBeChecked();
  await expect(party).toContainText("No own party ID requested");
});

test("demo: clear messages for a taken party and a missing operator name", async ({
  page,
  isMobile,
}) => {
  await openRoaming(page, isMobile);
  await page.getByLabel("Publish my sites to roaming partners").check();
  await page.getByRole("button", { name: "Save roaming settings" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText(
    "Operator name: needed to publish",
  );

  await page.getByLabel("Operator name").fill("Sample Charging Co");
  await page.getByLabel("Country code").fill("US");
  await page.getByRole("textbox", { name: "Party ID" }).fill("ZZZ");
  await page.getByRole("button", { name: "Save roaming settings" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText(
    "Ivora has already approved party US*ZZZ for another operator",
  );
  await expect(page.getByRole("region", { name: /Publishing/ })).toContainText(
    "Not published",
  );
});
