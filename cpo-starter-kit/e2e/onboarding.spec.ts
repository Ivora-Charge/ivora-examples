import { expect, test, type Page } from "@playwright/test";

// Demo mode: signed in as the labelled demo owner. Each test gets a fresh browser
// context, so a fresh, empty demo company (it lives in the visitor's cookie).

// A header-only PNG (64 x 64): enough for the kit's logo checks. Demo mode never
// uploads it.
function pngHeader(): Buffer {
  const b = Buffer.alloc(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(64, 16);
  b.writeUInt32BE(64, 20);
  b.write("IDAT", 37, "ascii");
  return b;
}

async function openSection(page: Page, isMobile: boolean, name: string) {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  if (isMobile) await nav.getByRole("button", { name: "Menu" }).click();
  await nav.getByRole("link", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

const checklist = (page: Page) =>
  page.getByRole("list", { name: "Setup checklist" });
// A save shows only the Saved state by its button, with the local time.
const saved = (page: Page, form: string) =>
  page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: form }) })
    .getByRole("status")
    .filter({ hasText: /Saved \d/ });
const checkItem = (page: Page, label: string) =>
  checklist(page).getByRole("listitem").filter({ hasText: label });

test("demo: the home page shows the setup checklist", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Setup checklist/ }),
  ).toBeVisible();
  await expect(checkItem(page, "Company details")).toContainText("To do");
  await expect(checkItem(page, "Brand")).toContainText("To do");
  await expect(checkItem(page, "Stripe ready")).toContainText("To do");
  // The demo project has sample chargers with sample tariffs.
  await expect(checkItem(page, "First charger")).toContainText("Done");
  await expect(checkItem(page, "First price")).toContainText("Done");
});

test("demo: the setup wizard takes company, brand and Stripe end to end", async ({
  page,
  isMobile,
}) => {
  await openSection(page, isMobile, "Onboarding");
  await expect(page).toHaveTitle(/^Onboarding · /);
  const steps = page.getByRole("navigation", { name: "Setup steps" });
  await expect(steps.getByRole("link", { name: /Company/ })).toHaveAttribute(
    "aria-current",
    "step",
  );

  // 1. Company
  await page.getByLabel("Company name").fill("Sample Charging Co");
  await page.getByLabel("Support email").fill("help@example.com");
  await page
    .getByLabel("Support URL (optional)")
    .fill("https://example.com/help");
  await page.getByLabel("Time zone").selectOption("Europe/Berlin");
  await page.getByLabel("Currency").selectOption("EUR");
  await page.getByRole("button", { name: "Save company details" }).click();
  await expect(saved(page, "Save company details")).toBeVisible();
  // Only "Saved": the save's message is not shown as well.
  await expect(page.getByText(/Company details saved/)).toHaveCount(0);

  // 2. Brand, with the contrast check and a logo that is checked, not uploaded.
  await page.getByRole("link", { name: "Next: Brand" }).click();
  await expect(steps.getByRole("link", { name: /Brand/ })).toHaveAttribute(
    "aria-current",
    "step",
  );
  await page.getByLabel("Brand colour").fill("#1d3fa8");
  await expect(
    page.getByText(/Light mode uses it .* Dark mode keeps the kit's colour/),
  ).toBeVisible();
  await page.getByLabel("Logo (optional)").setInputFiles({
    name: "logo.png",
    mimeType: "image/png",
    buffer: pngHeader(),
  });
  await page.getByRole("button", { name: "Save brand" }).click();
  await expect(saved(page, "Save brand")).toBeVisible();
  await expect(page.getByText(/Brand saved/)).toHaveCount(0);
  // The brand colour now themes the kit where it is readable.
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue(
          "--color-primary",
        ),
      ),
    )
    .toContain("#1d3fa8");

  // 3. Payments: Stripe is connected in the Ivora dashboard; demo simulates it.
  await page.getByRole("link", { name: "Next: Payments" }).click();
  const payments = page.getByRole("region", { name: /Card payments/ });
  await expect(payments).toContainText("Not connected");
  await expect(
    payments.getByRole("link", { name: "your Ivora dashboard" }),
  ).toHaveAttribute("href", /^https:\/\//);
  await expect(payments).toContainText("never sees or stores Stripe keys");
  await payments
    .getByLabel("Demo: simulate a Stripe status")
    .selectOption("pending_review");
  await payments.getByRole("button", { name: "Simulate" }).click();
  await expect(payments).toContainText("waiting for Ivora to approve it");
  await expect(
    payments.getByLabel("Demo: simulate a Stripe status"),
  ).toHaveValue("pending_review");
  await payments
    .getByLabel("Demo: simulate a Stripe status")
    .selectOption("ready_requirements");
  await payments.getByRole("button", { name: "Simulate" }).click();
  await expect(
    payments.getByRole("list", { name: "Open Stripe requirements" }),
  ).toContainText("company.tax_id");
  await payments
    .getByLabel("Demo: simulate a Stripe status")
    .selectOption("ready");
  await payments.getByRole("button", { name: "Simulate" }).click();
  await expect(payments).toContainText("Card payments are on");
  await payments.getByRole("button", { name: "Check status again" }).click();
  await expect(payments).toContainText("Card payments are on");

  // 4. Return domain: a sample record in demo mode, nothing is sent to Ivora.
  await page.getByRole("link", { name: "Next: Return domain" }).click();
  const domain = page.getByRole("region", { name: /Return domain/ });
  await expect(domain).toContainText("Sample");
  await expect(domain).toContainText("_ivora-return.charge.example.com");
  await expect(domain).toContainText("ivora-return-verification=");
  await expect(domain.getByRole("button")).toHaveCount(0);

  // The checklist follows.
  await page.getByRole("link", { name: "Back to Overview" }).click();
  // Setup is done: the key numbers and the 30-day chart lead, and the checklist is
  // one collapsed line under them.
  await expect(
    page.getByRole("heading", { name: /Energy, last 30 days/ }),
  ).toBeVisible();
  await expect(checklist(page)).toBeHidden();
  const order = await page.evaluate(() => {
    const at = (sel: string) =>
      document.querySelector(sel)?.getBoundingClientRect().top ?? Infinity;
    return [at(".stats"), at("#trend-heading"), at("details.setup")];
  });
  expect(order[0]).toBeLessThan(order[1]);
  expect(order[1]).toBeLessThan(order[2]);
  await page.locator("details.setup > summary").click();
  await expect(checklist(page)).toBeVisible();
  for (const label of ["Company details", "Brand", "Stripe ready"])
    await expect(checkItem(page, label)).toContainText("Done");
  // The sample chargers already have sample tariffs, so every step is done.
  await expect(page.getByText("5 of 5 done")).toBeVisible();
});

test("demo: settings show every step and refuse a logo that isn't an image", async ({
  page,
  isMobile,
}) => {
  await openSection(page, isMobile, "Settings");
  await expect(
    page.getByRole("heading", { name: /Company details/ }),
  ).toBeVisible();
  await expect(
    page.getByText("Save your company details first."),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: /Card payments/ }),
  ).toContainText("Not connected");

  await page.getByLabel("Company name").fill("Sample Charging Co");
  await page.getByLabel("Support email").fill("help@example.com");
  await page.getByLabel("Time zone").selectOption("UTC");
  await page.getByRole("button", { name: "Save company details" }).click();
  await expect(saved(page, "Save company details")).toBeVisible();

  await page.getByLabel("Brand colour").fill("#17613a");
  await page.getByLabel("Logo (optional)").setInputFiles({
    name: "logo.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
  });
  // The browser checks type and size first, with the API's limits, and blocks the save.
  await expect(page.locator("main").getByRole("alert")).toContainText(
    "Choose a PNG, JPEG or WebP image",
  );
  await page.getByRole("button", { name: "Save brand" }).click();
  await expect(saved(page, "Save brand")).toHaveCount(0);
  await page.getByLabel("Logo (optional)").setInputFiles({
    name: "big.png",
    mimeType: "image/png",
    buffer: Buffer.concat([pngHeader(), Buffer.alloc(1_100_000)]),
  });
  await expect(page.locator("main").getByRole("alert")).toContainText(
    "the limit is 512 KB",
  );
  // A readable shade replaces a colour drivers could not read on white.
  await page.getByLabel("Brand colour").fill("#ffff00");
  await expect(page.getByText(/so they use the darker shade #/)).toBeVisible();

  await page.getByRole("button", { name: "Reset the demo company" }).click();
  await expect(
    page.getByText("Save your company details first."),
  ).toBeVisible();
});

test("demo: the checklist can be hidden, and comes back", async ({ page }) => {
  await page.goto("/");
  // Setup is not done: the checklist leads and is open.
  await expect(checklist(page)).toBeVisible();
  await page.getByRole("button", { name: "Hide the checklist" }).click();
  await expect(checklist(page)).toBeHidden();
  await expect(page.locator(".stats")).toBeVisible();
  await page.locator("details.setup > summary").click();
  await page
    .getByRole("button", { name: "Show the checklist at the top" })
    .click();
  await expect(checklist(page)).toBeVisible();
});

test("demo: settings has its sections, a Saved time and the payments checklist", async ({
  page,
  isMobile,
}) => {
  await openSection(page, isMobile, "Settings");
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  for (const name of ["Company", "Brand", "Payments", "Team", "Roaming"])
    await expect(nav.getByRole("link", { name })).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Setup progress" }),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Payments checklist" }),
  ).toContainText("To do");
  await expect(page.getByRole("region", { name: "Team" })).toContainText(
    "demo-owner@example.com",
  );
  await page.getByLabel("Company name").fill("Sample Charging Co");
  await page.getByLabel("Support email").fill("help@example.com");
  await page.getByLabel("Time zone").selectOption("UTC");
  await page.getByRole("button", { name: "Save company details" }).click();
  await expect(page.locator("#company .saved time")).toBeVisible();
  await expect(page.locator("#company .saved")).toContainText(/Saved \d/);
});

test("demo: company and brand save the same values, kept after a reload", async ({
  page,
  isMobile,
}) => {
  await openSection(page, isMobile, "Settings");
  await page.getByLabel("Company name").fill("Sample Charging Co");
  await page.getByLabel("Support email").fill("Help@Example.com");
  await page
    .getByLabel("Support URL (optional)")
    .fill("https://example.com/help");
  await page.getByLabel("Website (optional)").fill("https://example.com");
  await page.getByLabel("Time zone").selectOption("Europe/Berlin");
  await page.getByLabel("Currency").selectOption("EUR");
  await page.getByRole("button", { name: "Save company details" }).click();
  await expect(saved(page, "Save company details")).toBeVisible();
  await page.getByLabel("Brand colour").fill("#1D3FA8");
  await page.getByRole("button", { name: "Save brand" }).click();
  await expect(saved(page, "Save brand")).toBeVisible();
  // The saved choices stay selected after the save, before any reload.
  await expect(page.getByLabel("Time zone")).toHaveValue("Europe/Berlin");
  await expect(page.getByLabel("Currency")).toHaveValue("EUR");

  await page.reload();
  await expect(page.getByLabel("Company name")).toHaveValue(
    "Sample Charging Co",
  );
  // Stored as before: the email in lower case, the colour as #rrggbb in lower case.
  await expect(page.getByLabel("Support email")).toHaveValue(
    "help@example.com",
  );
  await expect(page.getByLabel("Support URL (optional)")).toHaveValue(
    "https://example.com/help",
  );
  await expect(page.getByLabel("Website (optional)")).toHaveValue(
    "https://example.com",
  );
  await expect(page.getByLabel("Time zone")).toHaveValue("Europe/Berlin");
  await expect(page.getByLabel("Currency")).toHaveValue("EUR");
  await expect(page.getByLabel("Brand colour")).toHaveValue("#1d3fa8");
});

test("demo: a save error shows under its field, with a summary", async ({
  page,
  isMobile,
}) => {
  await openSection(page, isMobile, "Settings");
  // The browser can't catch this one; the server's check does.
  await page.getByLabel("Company name").fill("<b>Sample</b>");
  await page.getByLabel("Support email").fill("help@example.com");
  await page.getByLabel("Time zone").selectOption("UTC");
  await page.getByRole("button", { name: "Save company details" }).click();
  const message = "The name can't contain < > or control characters.";
  await expect(
    page.locator("main").getByRole("alert").filter({ hasText: message }),
  ).toBeVisible();
  const name = page.getByLabel("Company name");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveAccessibleDescription(new RegExp(message));
  await expect(saved(page, "Save company details")).toHaveCount(0);
  // The form keeps what was typed, so the error matches the text in the field.
  await expect(name).toHaveValue("<b>Sample</b>");
  await expect(page.getByLabel("Support email")).toHaveValue(
    "help@example.com",
  );
  await expect(page.getByLabel("Time zone")).toHaveValue("UTC");
  // Fixed, it saves and the error goes.
  await name.fill("Sample Charging Co");
  await page.getByRole("button", { name: "Save company details" }).click();
  await expect(saved(page, "Save company details")).toBeVisible();
  await expect(name).not.toHaveAttribute("aria-invalid");
  await expect(page.getByText(message)).toHaveCount(0);
});
