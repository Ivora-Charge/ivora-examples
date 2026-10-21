import { afterEach, describe, expect, it } from "vitest";
import { config } from "@/lib/server/env";
import { createMemoryLimiter, limit, sourceOf } from "@/lib/server/rate-limit";

const h = (o: Record<string, string>) => new Headers(o);

describe("rate-limit source", () => {
  it("trusts only Vercel's header on Vercel", () => {
    const vercel = { VERCEL: "1" };
    expect(
      sourceOf(
        h({
          "x-vercel-forwarded-for": "203.0.113.7",
          "x-forwarded-for": "1.1.1.1",
        }),
        vercel,
      ),
    ).toBe("203.0.113.7");
    expect(sourceOf(h({ "x-forwarded-for": "1.1.1.1" }), vercel)).toBeNull();
  });

  it("uses the configured proxy header, taking the entry the proxy added", () => {
    const env = { TRUSTED_PROXY_HEADER: "X-Forwarded-For" };
    // The caller wrote the first entry; the proxy appended the last.
    expect(
      sourceOf(h({ "x-forwarded-for": "6.6.6.6, 198.51.100.2" }), env),
    ).toBe("198.51.100.2");
    expect(
      sourceOf(h({ "cf-connecting-ip": "198.51.100.3" }), {
        TRUSTED_PROXY_HEADER: "cf-connecting-ip",
      }),
    ).toBe("198.51.100.3");
    expect(sourceOf(h({}), env)).toBeNull();
  });

  it("never trusts caller-set headers without configuration", () => {
    expect(
      sourceOf(h({ "x-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2" }), {}),
    ).toBeNull();
  });

  it("skips per-source quotas without a trusted source, so one client can't lock everyone out", async () => {
    const limiter = createMemoryLimiter();
    for (let i = 0; i < 100; i++)
      await limit(limiter, "k", "passwordSource", null);
    await expect(
      limit(limiter, "k", "passwordSource", "198.51.100.2"),
    ).resolves.toBeUndefined();
  });
});

describe("app URL", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  const set = (o: Record<string, string | undefined>) => {
    for (const k of [
      "APP_URL",
      "VERCEL_ENV",
      "VERCEL_URL",
      "VERCEL_BRANCH_URL",
      "VERCEL_PROJECT_PRODUCTION_URL",
    ])
      delete process.env[k];
    Object.assign(process.env, o);
  };

  it("uses APP_URL in production and locally", () => {
    set({ APP_URL: "https://ops.example.com/", VERCEL_ENV: "production" });
    expect(config.appUrl).toBe("https://ops.example.com");
    set({});
    expect(config.appUrl).toBe("http://localhost:3000");
  });

  it("links a preview deployment to itself, never to production", () => {
    set({
      APP_URL: "https://ops.example.com",
      VERCEL_ENV: "preview",
      VERCEL_URL: "kit-abc123.example.app",
      VERCEL_BRANCH_URL: "kit-git-branch.example.app",
      VERCEL_PROJECT_PRODUCTION_URL: "ops.example.com",
    });
    expect(config.appUrl).toBe("https://kit-git-branch.example.app");
  });
});

describe("Stripe settings link", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  const set = (o: Record<string, string>) => {
    for (const k of [
      "IVORA_DASHBOARD_URL",
      "IVORA_DASHBOARD_STRIPE_PATH",
      "IVORA_TENANT_ID",
    ])
      delete process.env[k];
    Object.assign(process.env, o);
  };

  it("opens the dashboard home unless a deep-link path is configured", () => {
    set({ IVORA_DASHBOARD_URL: "https://dash.example.com/ignored" });
    expect(config.stripeSettingsUrl).toBe("https://dash.example.com");
    set({
      IVORA_DASHBOARD_URL: "https://dash.example.com",
      IVORA_DASHBOARD_STRIPE_PATH: "/projects/{tenant_id}/settings",
      IVORA_TENANT_ID: "42",
    });
    expect(config.stripeSettingsUrl).toBe(
      "https://dash.example.com/projects/42/settings",
    );
  });

  it("never lets the path change the host or carry a script", () => {
    for (const bad of [
      "//evil.example/x",
      "https://evil.example",
      "javascript:alert(1)",
      "/a?next=https://evil.example",
      "settings",
    ]) {
      set({
        IVORA_DASHBOARD_URL: "https://dash.example.com",
        IVORA_DASHBOARD_STRIPE_PATH: bad,
      });
      expect(config.stripeSettingsUrl).toBe("https://dash.example.com");
    }
    // A tenant placeholder without a tenant ID falls back to the home page.
    set({
      IVORA_DASHBOARD_URL: "https://dash.example.com",
      IVORA_DASHBOARD_STRIPE_PATH: "/projects/{tenant_id}",
    });
    expect(config.stripeSettingsUrl).toBe("https://dash.example.com");
  });
});
