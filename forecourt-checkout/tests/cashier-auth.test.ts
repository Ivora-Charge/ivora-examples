import { describe, expect, it, vi } from "vitest";

// The cashier role can use the console; it never opens the operator pages.

const T0 = Date.parse("2026-10-20T15:00:00Z");
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { name, value: jar.get(name)! } : undefined,
  }),
}));

describe("cashier and operator roles", () => {
  const post = () =>
    new Request("http://localhost/api/cashier/sales", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });

  it("lets a cashier or an operator use the console, and keeps cashiers out of operator pages", async () => {
    vi.stubEnv("DEMO_MODE", "1");
    const { cashierRequest } = await import("@/lib/server/cashier-guard");
    const auth = await import("@/lib/server/auth");
    const { settings: read } = await import("@/lib/server/services");
    const s = read();
    jar.clear();
    await expect(cashierRequest(post())).rejects.toMatchObject({ status: 401 });
    jar.set(auth.CASHIER_COOKIE, auth.cashierToken(s));
    await expect(cashierRequest(post())).resolves.toBeTruthy();
    expect(await auth.isOperator(s)).toBe(false);
    jar.clear();
    jar.set(auth.OPERATOR_COOKIE, auth.operatorToken(s));
    await expect(cashierRequest(post())).resolves.toBeTruthy();
    // A cashier token can't be replayed as an operator one.
    jar.clear();
    jar.set(auth.OPERATOR_COOKIE, auth.cashierToken(s));
    expect(await auth.isOperator(s)).toBe(false);
    await expect(
      cashierRequest(
        new Request("http://localhost/api/cashier/sales", {
          method: "POST",
          headers: { "sec-fetch-site": "cross-site" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    vi.unstubAllEnvs();
  });

  it("rate-limits each login separately", async () => {
    const { loginAllowed } = await import("@/lib/server/auth");
    for (let i = 0; i < 10; i++)
      expect(loginAllowed("cashier:1.2.3.4", T0)).toBe(true);
    expect(loginAllowed("cashier:1.2.3.4", T0)).toBe(false);
    expect(loginAllowed("operator:1.2.3.4", T0)).toBe(true);
    expect(loginAllowed("cashier:1.2.3.4", T0 + 16 * 60_000)).toBe(true);
  });

  it("keys login limits on a trusted header only", async () => {
    const { loginClient } = await import("@/lib/server/auth");
    const h = (v: Record<string, string>) => new Headers(v);
    // No trusted source: a spoofed x-forwarded-for shares one bucket.
    expect(loginClient(h({ "x-forwarded-for": "1.1.1.1" }), {})).toBe("shared");
    expect(loginClient(h({ "x-forwarded-for": "2.2.2.2" }), {})).toBe("shared");
    // Configured: clients are keyed separately, last entry wins.
    const env = { TRUSTED_PROXY_HEADER: "X-Forwarded-For" };
    expect(loginClient(h({ "x-forwarded-for": "9.9.9.9, 1.1.1.1" }), env)).toBe(
      "1.1.1.1",
    );
    expect(loginClient(h({ "x-forwarded-for": "2.2.2.2" }), env)).toBe(
      "2.2.2.2",
    );
    expect(loginClient(h({}), env)).toBe("shared");
    // Vercel: its own header, and a client-set x-forwarded-for is ignored.
    const vercel = { VERCEL: "1" };
    expect(
      loginClient(
        h({
          "x-vercel-forwarded-for": "3.3.3.3",
          "x-forwarded-for": "4.4.4.4",
        }),
        vercel,
      ),
    ).toBe("3.3.3.3");
    expect(loginClient(h({ "x-forwarded-for": "4.4.4.4" }), vercel)).toBe(
      "shared",
    );
  });

  it("does not give a spoofed x-forwarded-for a fresh login quota", async () => {
    vi.stubEnv("DEMO_MODE", "1");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "");
    vi.stubEnv("VERCEL", "");
    const { POST } = await import("@/app/api/cashier/login/route");
    const attempt = async (ip: string) => {
      const body = new FormData();
      body.set("password", "wrong-guess");
      const r = await POST(
        new Request("http://localhost/api/cashier/login", {
          method: "POST",
          headers: { "sec-fetch-site": "same-origin", "x-forwarded-for": ip },
          body,
        }),
      );
      return r.headers.get("location") ?? "";
    };
    let last = "";
    for (let i = 0; i < 12; i++) last = await attempt(`198.51.100.${i}`);
    expect(last).toContain("too_many_attempts");
    vi.unstubAllEnvs();
  });

  it("signs cashiers out when CASHIER_PASSWORD changes", async () => {
    vi.stubEnv("DEMO_MODE", "1");
    vi.stubEnv("CASHIER_PASSWORD", "first-password");
    const { cashierRequest } = await import("@/lib/server/cashier-guard");
    const auth = await import("@/lib/server/auth");
    const { settings: read } = await import("@/lib/server/services");
    jar.clear();
    jar.set(auth.CASHIER_COOKIE, auth.cashierToken(read()));
    await expect(cashierRequest(post())).resolves.toBeTruthy();
    vi.stubEnv("CASHIER_PASSWORD", "second-password");
    await expect(cashierRequest(post())).rejects.toMatchObject({ status: 401 });
    jar.clear();
    vi.unstubAllEnvs();
  });

  it("caps how often one client reads the driver's screen", async () => {
    const { counterAllowed } = await import("@/lib/server/auth");
    for (let i = 0; i < 60; i++)
      expect(counterAllowed("5.6.7.8", T0)).toBe(true);
    expect(counterAllowed("5.6.7.8", T0)).toBe(false);
    expect(counterAllowed("5.6.7.9", T0)).toBe(true);
    expect(counterAllowed("5.6.7.8", T0 + 61_000)).toBe(true);
  });

  it("rate-limits emailed receipts per signed-in console and client, not for the whole site", async () => {
    vi.stubEnv("DEMO_MODE", "1");
    const auth = await import("@/lib/server/auth");
    const { settings: read } = await import("@/lib/server/services");
    const { POST } =
      await import("@/app/api/cashier/sales/[sale]/[action]/route");
    const s = read();
    const tills = {
      a: auth.cashierToken(s, Date.now()),
      b: auth.cashierToken(s, Date.now() + 1000), // another login: its own cookie
    };
    const send = async (till: keyof typeof tills, ip: string) => {
      jar.clear();
      jar.set(auth.CASHIER_COOKIE, tills[till]);
      const response = await POST(
        new Request(
          "http://localhost/api/cashier/sales/post-3fa9c01b77de/email",
          {
            method: "POST",
            headers: {
              "sec-fetch-site": "same-origin",
              "content-type": "application/json",
              "x-forwarded-for": ip,
            },
            // Malformed on purpose: the limit counts before the body is read, and nothing is sent.
            body: "{}",
          },
        ),
        {
          params: Promise.resolve({
            sale: "post-3fa9c01b77de",
            action: "email",
          }),
        },
      );
      return response.status;
    };
    for (let i = 0; i < 20; i++) expect(await send("a", "10.1.0.1")).toBe(400);
    expect(await send("a", "10.1.0.1")).toBe(429);
    // Another till, or the same login from another client, isn't held back.
    expect(await send("b", "10.1.0.1")).toBe(400);
    expect(await send("a", "10.1.0.2")).toBe(400);
    jar.clear();
    vi.unstubAllEnvs();
  });
});
