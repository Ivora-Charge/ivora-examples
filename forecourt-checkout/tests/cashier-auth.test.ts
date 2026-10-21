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
});
