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
  // The demo project has sample chargers; pricing comes in a later part.
  await expect(checkItem(page, "First charger")).toContainText("Done");
  await expect(checkItem(page, "First price")).toContainText("Coming soon");
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
  await expect(
    page.getByText(/Company details saved, and the name and support contacts/),
  ).toBeVisible();
  await expect(
    page.getByText("Demo: nothing was sent to Ivora."),
  ).toBeVisible();

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
  await expect(
    page.getByText(/Brand saved and on your driver payment pages/),
  ).toBeVisible();
  await expect(
    page.getByText(/Demo: the logo passed the checks but was not uploaded/),
  ).toBeVisible();
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

  // The checklist follows.
  await page.getByRole("link", { name: "Back to Overview" }).click();
  await expect(checklist(page)).toBeVisible();
  for (const label of ["Company details", "Brand", "Stripe ready"])
    await expect(checkItem(page, label)).toContainText("Done");
  await expect(page.getByText("4 of 5 done")).toBeVisible();
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
  await expect(page.getByText(/Company details saved/)).toBeVisible();

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
  await expect(page.getByText(/Brand saved/)).toBeHidden();
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
