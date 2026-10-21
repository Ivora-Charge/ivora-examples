import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/roles";
import {
  createDemoClient,
  DEMO_STRIPE_STATES,
  demoPaymentAccount,
} from "@/lib/server/ivora/demo";
import { IvoraError } from "@/lib/server/ivora/errors";
import type {
  Branding,
  BrandingInput,
  IvoraClient,
  LogoUpload,
  PaymentAccount,
} from "@/lib/server/ivora/types";
import { setupChecklist } from "@/lib/server/onboarding/checklist";
import {
  createDemoOnboardingStore,
  decodeDemoOnboarding,
  encodeDemoOnboarding,
  memoryDemoOnboarding,
} from "@/lib/server/onboarding/demo";
import { checkLogo, imageInfo } from "@/lib/server/onboarding/image";
import {
  brandingHash,
  brandingInSync,
  brandingPayload,
  loadOnboarding,
  loadStripe,
  saveBrand,
  saveCompany,
  syncBranding,
  type OnboardingDeps,
} from "@/lib/server/onboarding/service";
import { stripeView } from "@/lib/server/onboarding/stripe";
import { OnboardingError } from "@/lib/server/onboarding/types";
import type { Staff } from "@/lib/server/team/types";

// The onboarding rules run against the in-memory demo store and a fake Ivora client
// with mode "live", so the live branches (pushes, uploads, keys, errors) are covered
// with no network and no real credentials.

const OPERATOR = "10000000-0000-4000-8000-0000000000aa";

function staff(role: Role): Staff {
  return {
    userId: `00000000-0000-4000-8000-00000000000${role.length}`,
    email: `${role}@example.com`,
    role,
    operatorId: OPERATOR,
    operatorName: "Sample Operator",
    demo: false,
  };
}
const owner = staff("owner");
const manager = staff("manager");
const technician = staff("technician");
const viewer = staff("viewer");

const COMPANY = {
  name: "Sample Charging Co",
  supportEmail: "Help@Example.com",
  supportUrl: "https://example.com/help",
  website: "",
  timeZone: "Europe/Berlin",
  currency: "EUR",
};

function fakeIvora() {
  let logoUrl: string | null = null;
  const record = (b: BrandingInput): Branding => ({
    ...b,
    logo_url: logoUrl,
    is_default: false,
  });
  let last: BrandingInput | null = null;
  const api = {
    mode: "live" as const,
    putBranding: vi.fn(async (b: BrandingInput, _key: string) => {
      last = b;
      return record(b);
    }),
    putBrandingLogo: vi.fn(async (_l: LogoUpload, key: string) => {
      if (!last) throw new IvoraError(404, "branding_not_found", "Set first");
      logoUrl = `https://api.example.test/v1/branding/logos/${key}.png`;
      return record(last);
    }),
    getPaymentAccount: vi.fn(async (): Promise<PaymentAccount> => ({
      status: "none",
    })),
  };
  const unexpected = () => {
    throw new Error("unexpected Ivora call");
  };
  const client = new Proxy(api, {
    get: (t, k) => (k in t ? t[k as keyof typeof t] : unexpected),
  }) as unknown as IvoraClient;
  return { api, client };
}

function deps() {
  const cookie = memoryDemoOnboarding();
  const store = createDemoOnboardingStore(cookie);
  const ivora = fakeIvora();
  const d: OnboardingDeps = { store, ivora: ivora.client };
  return { d, cookie, store, ...ivora };
}

// Minimal image headers: enough for the checks, which read only the header.
function png(w: number, h: number, animated = false) {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const v = new DataView(b.buffer);
  v.setUint32(8, 13);
  b.set([...Buffer.from("IHDR")], 12);
  v.setUint32(16, w);
  v.setUint32(20, h);
  // Next chunk at 8 + 12 + 13 = 33.
  v.setUint32(33, animated ? 8 : 0);
  b.set([...Buffer.from(animated ? "acTL" : "IDAT")], 37);
  return b;
}
function jpeg(w: number, h: number) {
  const b = new Uint8Array(40);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255], 8);
  return b;
}
function webp(w: number, h: number, animated = false) {
  const b = new Uint8Array(30);
  b.set([...Buffer.from("RIFF")]);
  b.set([...Buffer.from("WEBPVP8X")], 8);
  b[16] = 10;
  b[20] = animated ? 0x02 : 0;
  b.set([(w - 1) & 255, ((w - 1) >> 8) & 255, 0], 24);
  b.set([(h - 1) & 255, ((h - 1) >> 8) & 255, 0], 27);
  return b;
}

describe("company details", () => {
  let errorLog: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorLog.mockRestore());

  it("saves for owners and managers and pushes the driver-page branding", async () => {
    const { d, api } = deps();
    const r = await saveCompany(d, manager, COMPANY);
    expect(r.sync).toEqual({ state: "synced" });
    const o = await loadOnboarding(d, manager);
    expect(o.companyDone).toBe(true);
    expect(o.profile).toMatchObject({
      name: "Sample Charging Co",
      supportEmail: "help@example.com",
      website: null,
      timeZone: "Europe/Berlin",
      currency: "EUR",
    });
    expect(api.putBranding).toHaveBeenCalledWith(
      {
        display_name: "Sample Charging Co",
        primary_color: null,
        support_email: "help@example.com",
        support_url: "https://example.com/help",
      },
      expect.stringMatching(/^cpo-branding-[\w-]+-put-0-[0-9a-f]{16}$/),
    );
    expect(o.inSync).toBe(true);
    // Brand needs a colour of its own.
    expect(o.brandDone).toBe(false);
    await saveCompany(d, owner, COMPANY);
  });

  it("refuses technicians and viewers before touching the store or Ivora", async () => {
    for (const actor of [technician, viewer]) {
      const { d, api, cookie } = deps();
      await expect(saveCompany(d, actor, COMPANY)).rejects.toMatchObject({
        code: "not_allowed",
      });
      await expect(
        saveBrand(d, actor, { primaryColor: "#17613a", logo: null }),
      ).rejects.toMatchObject({ code: "not_allowed" });
      await expect(syncBranding(d, actor)).rejects.toMatchObject({
        code: "not_allowed",
      });
      expect(cookie.state.profile.name).toBeNull();
      expect(api.putBranding).not.toHaveBeenCalled();
    }
    // The store checks the role too, in case a caller skips the service.
    const { store } = deps();
    await expect(
      store.saveCompany(technician, { ...COMPANY, website: null }),
    ).rejects.toBeInstanceOf(OnboardingError);
  });

  it.each([
    [{ name: "" }, /company name/],
    [{ name: "x".repeat(81) }, /at most 80/],
    [{ name: "<b>Bold</b>" }, /can't contain/],
    [{ supportEmail: "not-an-email" }, /valid support email/],
    [{ supportUrl: "http://example.com/help" }, /https:\/\//],
    [{ supportUrl: "https://user:pw@example.com" }, /https:\/\//],
    [{ website: "example.com" }, /https:\/\//],
    [{ timeZone: "Mars/Olympus" }, /time zone/],
    [{ currency: "XYZ1" }, /currency/],
    [{ currency: undefined }, /currency/],
  ])("rejects %o", async (change, message) => {
    const { d, api } = deps();
    await expect(
      saveCompany(d, owner, { ...COMPANY, ...change }),
    ).rejects.toThrow(message);
    expect(api.putBranding).not.toHaveBeenCalled();
  });

  it("keeps the details when Ivora fails, and says so", async () => {
    const { d, api } = deps();
    api.putBranding.mockRejectedValueOnce(
      new IvoraError(403, "forbidden", "Missing permission", "req_9"),
    );
    const r = await saveCompany(d, owner, COMPANY);
    expect(r.sync.state).toBe("failed");
    if (r.sync.state === "failed") {
      expect(r.sync.error).toMatch(/forbidden.*Check the API key.*req_9/);
      expect(r.sync.error).not.toMatch(/test-key/);
    }
    const o = await loadOnboarding(d, owner);
    expect(o.companyDone).toBe(true);
    expect(o.inSync).toBe(false);
    // Logs carry the code and request ID only.
    expect(JSON.stringify(errorLog.mock.calls)).not.toMatch(/example\.com/);
    // Push again: same content, same key as the failed try.
    expect(await syncBranding(d, owner, { force: true })).toEqual({
      state: "synced",
    });
    const [k1, k2] = api.putBranding.mock.calls.map((c) => c[1]);
    expect(k2).toBe(k1);
    expect((await loadOnboarding(d, owner)).inSync).toBe(true);
  });
});

describe("brand", () => {
  it("needs the company details first", async () => {
    const { d, api } = deps();
    await expect(
      saveBrand(d, owner, { primaryColor: "#17613a", logo: null }),
    ).rejects.toMatchObject({ code: "no_company" });
    expect(api.putBranding).not.toHaveBeenCalled();
  });

  it("saves the colour, pushes it and marks the brand done", async () => {
    const { d, api } = deps();
    await saveCompany(d, owner, COMPANY);
    const r = await saveBrand(d, manager, {
      primaryColor: "#1D3FA8",
      logo: null,
    });
    expect(r).toEqual({ sync: { state: "synced" }, logo: null });
    expect(api.putBranding.mock.calls[1][0].primary_color).toBe("#1d3fa8");
    const o = await loadOnboarding(d, owner);
    expect(o.brandDone).toBe(true);
    await expect(
      saveBrand(d, owner, { primaryColor: "blue", logo: null }),
    ).rejects.toThrow(/#rrggbb/);
  });

  it("derives a new Idempotency-Key for each change, even back to an earlier brand", async () => {
    const { d, api } = deps();
    await saveCompany(d, owner, COMPANY);
    for (const c of ["#1d3fa8", "#17613a", "#1d3fa8"])
      await saveBrand(d, owner, { primaryColor: c, logo: null });
    const keys = api.putBranding.mock.calls.map((c) => c[1]);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    // Unchanged content is not pushed again unless asked.
    await saveBrand(d, owner, { primaryColor: "#1d3fa8", logo: null });
    expect(api.putBranding).toHaveBeenCalledTimes(4);
  });

  it("uploads a checked logo after the branding, with its own key", async () => {
    const { d, api } = deps();
    await saveCompany(d, owner, COMPANY);
    const r = await saveBrand(d, owner, {
      primaryColor: "#17613a",
      logo: png(256, 128),
    });
    expect(r.logo).toEqual({ state: "uploaded" });
    const [logo, key] = api.putBrandingLogo.mock.calls[0];
    expect(logo.contentType).toBe("image/png");
    expect(key).toMatch(/^cpo-logo-[\w-]+-put-0-[0-9a-f]{16}$/);
    expect(api.putBranding.mock.invocationCallOrder.at(-1)).toBeLessThan(
      api.putBrandingLogo.mock.invocationCallOrder[0],
    );
    const o = await loadOnboarding(d, owner);
    expect(o.profile.logoUrl).toMatch(/^https:\/\/api\.example\.test\//);
    expect(o.profile.logoUploads).toBe(1);
    // A later upload of the same image gets a new key.
    await saveBrand(d, owner, { primaryColor: "#17613a", logo: png(256, 128) });
    expect(api.putBrandingLogo.mock.calls[1][1]).not.toBe(key);
  });

  it("refuses a wrong logo before saving or sending anything", async () => {
    const { d, api } = deps();
    await saveCompany(d, owner, COMPANY);
    api.putBranding.mockClear();
    const svg = new TextEncoder().encode(
      "<svg xmlns='http://www.w3.org/2000/svg'/>",
    );
    for (const [bytes, message] of [
      [svg, /SVG isn't accepted/],
      [png(16, 16), /32 to 2048/],
      [jpeg(4096, 100), /32 to 2048/],
      [png(64, 64, true), /animated/],
      [webp(64, 64, true), /animated/],
      [new Uint8Array(512 * 1024 + 1), /512 KB/],
    ] as const) {
      await expect(
        saveBrand(d, owner, { primaryColor: "#123456", logo: bytes }),
      ).rejects.toThrow(message);
    }
    expect((await loadOnboarding(d, owner)).profile.primaryColor).toBeNull();
    expect(api.putBranding).not.toHaveBeenCalled();
    expect(api.putBrandingLogo).not.toHaveBeenCalled();
  });

  it("does not upload the logo when the branding push failed", async () => {
    const { d, api } = deps();
    await saveCompany(d, owner, COMPANY);
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    api.putBranding.mockRejectedValueOnce(
      new IvoraError(503, "unavailable", "Busy"),
    );
    const r = await saveBrand(d, owner, {
      primaryColor: "#17613a",
      logo: png(64, 64),
    });
    expect(r.sync.state).toBe("failed");
    expect(r.logo).toBeNull();
    expect(api.putBrandingLogo).not.toHaveBeenCalled();
  });

  it("checks but never uploads a logo in demo mode", async () => {
    const cookie = memoryDemoOnboarding();
    const demo = createDemoClient();
    const upload = vi.spyOn(demo, "putBrandingLogo");
    const d: OnboardingDeps = {
      store: createDemoOnboardingStore(cookie),
      ivora: demo,
    };
    await saveCompany(d, owner, COMPANY);
    const r = await saveBrand(d, owner, {
      primaryColor: "#17613a",
      logo: webp(300, 100),
    });
    expect(r).toEqual({ sync: { state: "synced" }, logo: { state: "demo" } });
    expect(upload).not.toHaveBeenCalled();
    expect(cookie.state.profile.logoUrl).toBeNull();
    expect(brandingInSync(cookie.state.profile)).toBe(true);
  });

  it("hashes the payload so any driver-visible change needs a new push", () => {
    const base = brandingPayload({
      ...decodeDemoOnboarding(undefined).profile,
      name: "A",
    })!;
    const h = brandingHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    for (const change of [
      { display_name: "B" },
      { primary_color: "#000000" },
      { support_email: "x@example.com" },
      { support_url: "https://example.com" },
    ])
      expect(brandingHash({ ...base, ...change })).not.toBe(h);
  });
});

describe("logo checks", () => {
  it("reads type and size from the image's own header", () => {
    expect(imageInfo(png(640, 200))).toEqual({
      contentType: "image/png",
      width: 640,
      height: 200,
      animated: false,
    });
    expect(imageInfo(jpeg(300, 150))).toMatchObject({
      contentType: "image/jpeg",
      width: 300,
      height: 150,
    });
    expect(imageInfo(webp(2048, 32))).toMatchObject({
      contentType: "image/webp",
      width: 2048,
      height: 32,
    });
    expect(imageInfo(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(checkLogo(jpeg(32, 2048)).contentType).toBe("image/jpeg");
  });
});

describe("Stripe status", () => {
  it.each([
    [{ status: "none" }, "none", "Not connected"],
    [{ status: "disconnected" }, "none", "Not connected"],
    [
      { status: "pending_review", charges_enabled: true },
      "pending_review",
      "Awaiting Ivora approval",
    ],
    [{ status: "active", charges_enabled: false }, "pending", "Pending"],
    [{ status: "active", charges_enabled: true }, "ready", "Ready"],
    [{ status: "something_new" }, "pending", "Pending"],
  ] as [PaymentAccount, string, string][])(
    "%o shows as %s",
    (account, state, label) => {
      expect(stripeView(account)).toMatchObject({ state, label });
    },
  );

  it("shows open requirements, the reason and the mode", () => {
    const v = stripeView(demoPaymentAccount("pending"));
    expect(v.requirements).toEqual([
      "external_account",
      "individual.verification.document",
    ]);
    expect(v.disabledReason).toBe("requirements.past_due");
    expect(v.livemode).toBe(false);
    const ready = stripeView(demoPaymentAccount("ready_requirements"));
    expect(ready.state).toBe("ready");
    expect(ready.detail).toMatch(/open requirements/);
  });

  it("reads the account in live mode and reports errors with their code", async () => {
    const { d, api } = deps();
    // A live store has no demo simulation.
    const live: OnboardingDeps = {
      store: { ...d.store, demoStripe: undefined },
      ivora: d.ivora,
    };
    api.getPaymentAccount.mockResolvedValueOnce({
      status: "active",
      charges_enabled: true,
    });
    expect(await loadStripe(live)).toMatchObject({
      ok: true,
      view: { state: "ready" },
    });
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    api.getPaymentAccount.mockRejectedValueOnce(
      new IvoraError(403, "insufficient_scope", "Needs billing:read"),
    );
    const r = await loadStripe(live);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/insufficient_scope/);
  });

  it("simulates every status in demo mode, per visitor", async () => {
    const { d, store, api } = deps();
    for (const s of DEMO_STRIPE_STATES) {
      await store.setDemoStripe!(s);
      const r = await loadStripe(d);
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(r.view.state).toBe(s === "ready_requirements" ? "ready" : s);
    }
    expect(api.getPaymentAccount).not.toHaveBeenCalled();
  });
});

describe("setup checklist", () => {
  it("follows company, brand, Stripe and chargers; pricing comes later", async () => {
    const { d, store } = deps();
    const items = async (chargers: number | null) =>
      setupChecklist(
        await loadOnboarding(d, owner),
        await loadStripe(d),
        chargers,
      ).map((i) => [i.key, i.state]);
    expect(await items(null)).toEqual([
      ["company", "todo"],
      ["brand", "todo"],
      ["stripe", "todo"],
      ["charger", "soon"],
      ["price", "soon"],
    ]);
    await saveCompany(d, owner, COMPANY);
    await saveBrand(d, owner, { primaryColor: "#17613a", logo: null });
    await store.setDemoStripe!("ready");
    expect(await items(3)).toEqual([
      ["company", "done"],
      ["brand", "done"],
      ["stripe", "done"],
      ["charger", "done"],
      ["price", "soon"],
    ]);
  });
});

describe("demo onboarding cookie", () => {
  it("round-trips and falls back to an empty company on tampering", () => {
    const s = decodeDemoOnboarding(undefined);
    s.profile.name = "Sample Co";
    s.stripe = "pending_review";
    expect(decodeDemoOnboarding(encodeDemoOnboarding(s))).toEqual(s);
    const bad = Buffer.from(
      JSON.stringify({ ...s, profile: { ...s.profile, primaryColor: "red" } }),
    ).toString("base64url");
    expect(decodeDemoOnboarding(bad).profile.name).toBeNull();
    expect(decodeDemoOnboarding("%%%").stripe).toBe("none");
  });
});
