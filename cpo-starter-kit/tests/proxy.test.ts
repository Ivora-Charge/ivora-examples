import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The sign-in routing in proxy.ts, in live mode with Supabase stubbed: who is sent
// where. No network: getClaims answers from `claims`.
let claims: { sub: string } | null = null;
let demo = false;

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getClaims: async () => ({ data: claims ? { claims } : null }) },
  }),
}));
vi.mock("@/lib/server/env", () => ({
  isDemo: () => demo,
  config: {
    supabaseUrl: "http://supabase.test",
    supabaseAnonKey: "anon-test",
    appUrl: "http://localhost:3000",
  },
}));

const { proxy } = await import("@/proxy");

async function visit(path: string) {
  const res = await proxy(new NextRequest(`http://localhost:3000${path}`));
  const location = res.headers.get("location");
  return location ? new URL(location).pathname : null;
}

beforeEach(() => {
  claims = null;
  demo = false;
});

describe("proxy, signed out", () => {
  it("sends the root to the landing page", async () => {
    expect(await visit("/")).toBe("/welcome");
  });

  it("sends deep links to sign-in (the kit keeps no return path)", async () => {
    for (const path of [
      "/chargers",
      "/pricing/123",
      "/reports?period=7d",
      // Public pages match exactly, not as a prefix.
      "/welcome-anything",
      "/login/more",
    ])
      expect(await visit(path), path).toBe("/login");
  });

  it("lets the landing page, sign-in and driver pages through", async () => {
    for (const path of [
      "/welcome",
      "/login",
      "/setup",
      "/invite",
      "/c/ABC123",
      "/api/webhooks/ivora",
    ])
      expect(await visit(path), path).toBeNull();
  });

  it("marks every answer private", async () => {
    const res = await proxy(new NextRequest("http://localhost:3000/welcome"));
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("proxy, signed in", () => {
  it("leaves the root and deep links alone", async () => {
    claims = { sub: "staff-1" };
    for (const path of ["/", "/chargers", "/welcome"])
      expect(await visit(path), path).toBeNull();
  });
});

describe("proxy, demo mode", () => {
  it("does nothing: the demo has no sign-in", async () => {
    demo = true;
    expect(await visit("/")).toBeNull();
    expect(await visit("/chargers")).toBeNull();
  });
});
