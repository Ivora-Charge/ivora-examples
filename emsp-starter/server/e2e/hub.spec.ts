import { expect, test } from "@playwright/test";
import { SETUPS } from "../playwright.config";
import { expectAccessible, goTo, signIn } from "./support";

// The "live-admin" setup: a database stand-in (e2e/fake-database.mjs) holds a
// registered roaming hub with no trusted party and no hubclientinfo module.
test.use({ baseURL: SETUPS.find((s) => s.name === "live-admin")!.url });
const schemes = ["light", "dark"] as const;

test("live-admin: a hub with no trusted party says so, and Pull points at the form to add one", async ({
  page,
}) => {
  await signIn(page);
  await goTo(page, "Peers");
  await page
    .getByRole("list", { name: "Peers" })
    .getByRole("link", { name: /Example Roaming Hub/ })
    .click();
  await expect(
    page.getByRole("heading", { name: /Example Roaming Hub/, level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByText("Connected, but idle: no party is trusted yet."),
  ).toBeVisible();
  await expect(
    page.getByText(
      "This hub does not publish a list of parties: add the party your hub contact gave you.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Read the hub's list again" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Party ID")).toBeVisible();

  await page.getByRole("button", { name: "Pull changes now" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "trusted yet" });
  await expect(alert).toContainText("no_trusted_party");
  await expect(alert).not.toContainText("Check the fields above");
  await alert.getByRole("link", { name: /add-a-party form/ }).click();
  await expect(page.getByLabel("Country")).toBeFocused();

  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `hub page, no trusted party, ${colorScheme}`);
  }
});

test("live-admin: a party the hub sent and we refused is listed, and Accept this party trusts it", async ({
  page,
}) => {
  await signIn(page);
  await goTo(page, "Peers");
  await page
    .getByRole("list", { name: "Peers" })
    .getByRole("link", { name: /Example Roaming Hub/ })
    .click();
  const refused = page.getByRole("region", { name: /Refused/ });
  await expect(
    refused.getByText("A party sent us data and was refused: NL-XYZ"),
  ).toBeVisible();
  await expect(refused).toContainText("3 times, last at");
  await expect(refused).toContainText(
    "Its OCPI-from party is not trusted behind this hub.",
  );
  // A party the hub only named in the URL: its own headline, and nothing to accept.
  await expect(
    refused.getByText("A trusted party sent data naming BE-QQQ"),
  ).toBeVisible();
  await expect(
    refused.getByRole("button", { name: /Accept this party BE-QQQ/ }),
  ).toHaveCount(0);
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `hub page, a refused party, ${colorScheme}`);
  }
  // The same gated, audited action as the add-a-party form.
  await refused
    .getByRole("button", { name: "Accept this party NL-XYZ", exact: true })
    .click();
  await expect(
    page.getByText("NL-XYZ is trusted through Example Roaming Hub."),
  ).toBeVisible();
});
