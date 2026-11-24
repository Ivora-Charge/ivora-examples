import { expect, test } from "@playwright/test";
import { expectAccessible, goTo, signIn } from "./support";

// Demo mode: peers live in memory and nothing is sent to a CPO or a hub.
const schemes = ["light", "dark"] as const;

test("demo: Peers shows only a sign-in prompt until an admin signs in", async ({
  page,
}) => {
  for (const path of ["/admin/peers", "/admin/peers/connect"]) {
    await page.goto(path);
    const gate = page.getByRole("region", { name: /^Sign in as an admin to / });
    await expect(gate.getByRole("link", { name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Admin secret")).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Peers" })).toHaveCount(0);
    for (const colorScheme of schemes) {
      await page.emulateMedia({ colorScheme });
      await expectAccessible(page, `${path}, signed out, ${colorScheme}`);
    }
  }
});

test("demo: the peer list opens by itself, and a peer is a row you open", async ({
  page,
}) => {
  await signIn(page);
  await goTo(page, "Peers");
  await expect(
    page.getByRole("heading", { name: "Peers", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("peers are kept in memory only")).toBeVisible();
  const list = page.getByRole("list", { name: "Peers" });
  const mock = list.getByRole("link", { name: /Mock CPO \(demo, built in\)/ });
  await expect(mock).toContainText("Registered");
  await expect(page.getByLabel("Our versions URL")).toContainText(
    "/ocpi/versions",
  );
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `peers, ${colorScheme}`);
  }

  await mock.click();
  await expect(
    page.getByRole("heading", {
      name: /Mock CPO \(demo, built in\)/,
      level: 1,
    }),
  ).toBeVisible();
  await expect(page.getByText("Built in: the demo's mock CPO.")).toBeVisible();
  // The built-in peer has nothing to rotate, pull or remove.
  await expect(page.getByRole("button", { name: "Unregister" })).toHaveCount(0);
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `peer page, ${colorScheme}`);
  }
});

test("demo: connect starts from what you were given; the hub path has its own words", async ({
  page,
}) => {
  await signIn(page);
  await goTo(page, "Peers");
  await page.getByRole("link", { name: "Connect a peer" }).click();
  await expect(
    page.getByRole("heading", { name: "Connect a peer", level: 1 }),
  ).toBeVisible();
  for (const name of [
    /A roaming hub gave me a one-time token/,
    /A CPO gave me a token/,
    /They will register with us/,
  ])
    await expect(page.getByRole("button", { name })).toBeVisible();
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `connect, choose, ${colorScheme}`);
  }

  await page
    .getByRole("button", { name: /A roaming hub gave me a one-time token/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Connect a roaming hub", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Steps" }).locator('[aria-current="step"]'),
  ).toHaveText("1. Token");
  const what = page
    .getByRole("complementary")
    .filter({ hasText: "What happens" });
  await expect(what).toContainText(
    "Our credentials are sent with the one-time token.",
  );
  await expect(what).toContainText(
    "We keep the hub's token encrypted and ours only as a hash.",
  );
  await expect(what).toContainText(
    "you accept the parties you trade with next",
  );
  await expect(what).toContainText(
    "subscription you set in the hub's own portal",
  );
  await expect(page.getByLabel("One-time token")).toHaveAttribute(
    "type",
    "password",
  );
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `connect, hub form, ${colorScheme}`);
  }

  // Demo mode refuses to register anywhere, with its own code and next step.
  await page.getByLabel("Name").fill("Example Roaming Hub");
  await page
    .getByLabel("Hub versions URL")
    .fill("https://hub.example.net/ocpi/versions");
  await page.getByLabel("One-time token").fill("sample-token-0001");
  await page.getByRole("button", { name: "Start the handshake" }).click();
  const alert = page.locator(".msg[role=alert]");
  await expect(alert).toContainText(
    "Demo mode: refused to register at a CPO. Nothing was sent.",
  );
  await expect(alert).toContainText("demo_mode");
  // What was typed is kept for the next try.
  await expect(page.getByLabel("Name")).toHaveValue("Example Roaming Hub");
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `connect, failed, ${colorScheme}`);
  }
});

test("demo: they register with us: a one-time token, shown once, then a row that waits", async ({
  page,
}) => {
  const name = `Example CPO ${test.info().project.name} ${Date.now()}`;
  await signIn(page);
  await goTo(page, "Peers");
  await page.getByRole("link", { name: "Connect a peer" }).click();
  await page
    .getByRole("button", { name: /They will register with us/ })
    .click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create the one-time token" }).click();
  const result = page.getByRole("status").filter({ hasText: "created" });
  await expect(result).toContainText("shown only this once");
  await expect(result.getByLabel("Our versions URL")).toContainText(
    "/ocpi/versions",
  );
  await expect(result.getByLabel("One-time token")).not.toBeEmpty();
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectAccessible(page, `connect, invited, ${colorScheme}`);
  }

  await page.getByRole("link", { name: "See peers" }).click();
  const row = page
    .getByRole("list", { name: "Peers" })
    .getByRole("link", { name: new RegExp(name) });
  await expect(row).toContainText("Waiting for them to register");

  // Its actions are on its own page: nobody copies a peer ID.
  await row.click();
  await expect(
    page.getByRole("heading", { name: new RegExp(name), level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Waiting for them to register.")).toBeVisible();
  await page.getByRole("button", { name: "Unregister" }).click();
  await page.getByRole("button", { name: "Yes, unregister" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: `Unregistered ${name}.` }),
  ).toBeVisible();
});

test("OCPI versions endpoint refuses unknown tokens", async ({ request }) => {
  const res = await request.get("/ocpi/versions", {
    headers: { Authorization: `Token ${btoa("unknown")}` },
  });
  expect(res.status()).toBe(401);
  expect(await res.json()).toMatchObject({ status_code: 2000 });
});
