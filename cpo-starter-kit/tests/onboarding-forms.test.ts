import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionState } from "@/lib/action-state";

// The forms post to these server actions; the test only renders the forms.
vi.mock("@/app/(staff)/onboarding/actions", () => ({
  saveCompanyAction: vi.fn(),
  saveBrandAction: vi.fn(),
  pushBrandingAction: vi.fn(),
  registerReturnDomainAction: vi.fn(),
  verifyReturnDomainAction: vi.fn(),
}));

// The state a save left behind, so the test can render a form after one.
let state: ActionState = {};
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useActionState: (action: unknown) => [state, action, false],
  };
});

const { CompanyForm, BrandForm } =
  await import("@/app/(staff)/onboarding/forms");

const ATTRS = [
  "name",
  "type",
  "required",
  "pattern",
  "maxLength",
  "accept",
] as const;

/** Each named control in the markup: its tag and the attributes the server reads. */
function controls(html: string) {
  const out: Record<string, Record<string, string | boolean>> = {};
  for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs: Record<string, string | boolean> = { tag: m[1] };
    for (const a of m[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g))
      // A boolean attribute renders as required="".
      attrs[a[1].toLowerCase()] =
        a[2] === "" || a[2] === undefined ? true : a[2];
    if (typeof attrs.name !== "string") continue;
    const picked: Record<string, string | boolean> = { tag: m[1] };
    for (const k of ATTRS)
      if (attrs[k.toLowerCase()] !== undefined)
        picked[k] = attrs[k.toLowerCase()];
    out[attrs.name] = picked;
  }
  return out;
}

const company = () =>
  renderToStaticMarkup(
    h(CompanyForm, {
      defaults: {
        name: "Sample Charging Co",
        supportEmail: "help@example.com",
        supportUrl: "https://example.com/help",
        website: "",
        timeZone: "UTC",
        currency: "USD",
      },
      timeZones: ["UTC", "Europe/Berlin"],
      currencies: ["USD", "EUR"],
    }),
  );

const brand = () =>
  renderToStaticMarkup(
    h(BrandForm, { color: "#17613a", hasLogo: false, name: "Sample" }),
  );

beforeEach(() => {
  state = {};
});

describe("company and brand forms: what they send (unchanged since 20e097e)", () => {
  it("company form posts the same six fields with the same browser checks", () => {
    expect(controls(company())).toEqual({
      name: { tag: "input", name: "name", required: true, maxLength: "80" },
      supportEmail: {
        tag: "input",
        name: "supportEmail",
        type: "email",
        required: true,
        maxLength: "254",
      },
      supportUrl: {
        tag: "input",
        name: "supportUrl",
        type: "url",
        pattern: "https://.*",
        maxLength: "300",
      },
      website: {
        tag: "input",
        name: "website",
        type: "url",
        pattern: "https://.*",
        maxLength: "300",
      },
      timeZone: { tag: "select", name: "timeZone", required: true },
      currency: { tag: "select", name: "currency", required: true },
    });
  });

  it("company form fills in the saved values", () => {
    const html = company();
    expect(html).toContain('name="name" value="Sample Charging Co"');
    expect(html).toContain('value="help@example.com"');
    expect(html).toContain('value="https://example.com/help"');
    expect(html).toMatch(/<option value="UTC" selected="">/);
    expect(html).toMatch(/<option value="USD" selected="">/);
  });

  it("brand form posts the colour and the logo, with the same checks", () => {
    const html = brand();
    expect(controls(html)).toEqual({
      primaryColor: {
        tag: "input",
        name: "primaryColor",
        required: true,
        pattern: "#[0-9a-fA-F]{6}",
        maxLength: "7",
      },
      logo: {
        tag: "input",
        name: "logo",
        type: "file",
        accept: "image/png,image/jpeg,image/webp",
      },
    });
    expect(html).toContain('name="primaryColor" value="#17613a"');
  });
});

describe("company and brand forms: Saved state and inline errors", () => {
  it("after a save shows only Saved with its time, not the save message", () => {
    state = {
      ok: "Company details saved. Demo: nothing was sent to Ivora.",
      savedAt: Date.UTC(2026, 10, 14, 9, 30),
    };
    const html = company();
    expect(html).not.toContain("Company details saved");
    expect(html).toMatch(/class="saved" role="status">.*Saved.*<time/);
  });

  it("after a save keeps a warning that needs attention", () => {
    state = {
      ok: "Brand saved.",
      warning:
        "Saved in the kit, but Ivora's driver payment pages were not updated.",
      savedAt: 1,
    };
    const html = brand();
    expect(html).not.toContain("Brand saved.");
    expect(html).toContain("driver payment pages were not updated");
  });

  it("puts each error under its field, with the summary above the form", () => {
    state = {
      error: "Enter a valid support email.",
      fieldErrors: {
        supportEmail: "Enter a valid support email.",
        website: "The website must be a full https:// address.",
      },
    };
    const html = company();
    expect(html).toMatch(/role="alert"><p>Enter a valid support email\./);
    expect(html).toContain("Check the fields marked below.");
    const email = /<input[^>]*name="supportEmail"[^>]*>/.exec(html)![0];
    expect(email).toContain('aria-invalid="true"');
    const errId = /aria-describedby="([^"]+)"/.exec(email)![1];
    expect(html).toContain(
      `<p id="${errId}" class="field-error">Enter a valid support email.</p>`,
    );
    expect(html).toContain(
      'class="field-error">The website must be a full https:// address.</p>',
    );
    // A field without an error is left alone.
    const name = /<input[^>]*name="name"[^>]*>/.exec(html)![0];
    expect(name).not.toContain("aria-invalid");
    // No Saved state after a failed save.
    expect(html).toContain('<span class="saved" role="status"></span>');
  });

  it("keeps what was typed after a refused save, not the saved values", () => {
    state = {
      error: "The name can't contain < > or control characters.",
      fieldErrors: {
        name: "The name can't contain < > or control characters.",
      },
      values: {
        name: "<b>Sample</b>",
        supportEmail: "new@example.com",
        supportUrl: "",
        website: "",
        timeZone: "Europe/Berlin",
        currency: "EUR",
      },
    };
    const html = company();
    expect(html).toContain('name="name" value="&lt;b&gt;Sample&lt;/b&gt;"');
    expect(html).toContain('value="new@example.com"');
    expect(html).not.toContain("https://example.com/help");
    expect(html).toMatch(/<option value="Europe\/Berlin" selected="">/);
    expect(html).toMatch(/<option value="EUR" selected="">/);
  });

  it("brand form shows colour and logo errors under those fields", () => {
    state = {
      error: "The file isn't a PNG, JPEG or WebP image.",
      fieldErrors: {
        primaryColor: "Enter the colour as #rrggbb, for example #17613a.",
        logo: "The file isn't a PNG, JPEG or WebP image.",
      },
    };
    const html = brand();
    const color = /<input[^>]*name="primaryColor"[^>]*>/.exec(html)![0];
    expect(color).toContain('aria-invalid="true"');
    expect(color).toMatch(/aria-describedby="[^"]*-color-error"/);
    expect(html).toContain(
      'class="field-error">Enter the colour as #rrggbb, for example #17613a.</p>',
    );
    const logo = /<input[^>]*name="logo"[^>]*>/.exec(html)![0];
    expect(logo).toContain('aria-invalid="true"');
    expect(html).toMatch(
      /class="field-error">The file isn&#x27;t a PNG, JPEG or WebP image\.<\/span>/,
    );
  });

  it("the driver-page preview uses the brand token for its text, not a raw colour", () => {
    const preview = /<div class="brand-preview"[\s\S]*?<\/div>/.exec(
      brand(),
    )![0];
    expect(preview).toContain(
      'style="background:#17613a;color:var(--color-on-driver)"',
    );
    expect(preview).not.toMatch(/#ffffff/i);
  });
});
