import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Server actions read the request's cookies and headers; tests set them here.
const requestCookies = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      requestCookies.has(name)
        ? { name, value: requestCookies.get(name) }
        : undefined,
    set: (name: string, value: string) => requestCookies.set(name, value),
    delete: (name: string) => requestCookies.delete(name),
  }),
  headers: async () => new Headers(),
}));

import { ADMIN_COOKIE, adminFromToken } from "@/lib/accounts/admin-session";
import { clearUserCacheForTests } from "@/lib/accounts/api";
import { DEMO_CODE, DemoAuth, SupabaseAuth } from "@/lib/accounts/auth";
import {
  DEMO_CARD_ID,
  setAccountStoreForTests,
  setAuthProviderForTests,
} from "@/lib/accounts/registry";
import { MemoryAccountStore } from "@/lib/accounts/store";
import {
  ensureAccount,
  resetSignInLimitsForTests,
  SIGN_IN_LIMITS,
} from "@/lib/accounts/sign-in";
import {
  POST as codePOST,
  OPTIONS as codeOPTIONS,
} from "@/app/api/v1/auth/code/route";
import { POST as verifyPOST } from "@/app/api/v1/auth/verify/route";
import { POST as refreshPOST } from "@/app/api/v1/auth/refresh/route";
import { POST as signOutPOST } from "@/app/api/v1/auth/sign-out/route";
import { GET as meGET } from "@/app/api/v1/me/route";
import { GET as cardsGET } from "@/app/api/v1/cards/route";
import { POST as setupPOST } from "@/app/api/v1/cards/setup/route";
import { PUT as defaultPUT } from "@/app/api/v1/cards/default/route";
import { DELETE as cardDELETE } from "@/app/api/v1/cards/[id]/route";
import { POST as chargePOST } from "@/app/api/v1/charges/route";
import { GET as chargeGET } from "@/app/api/v1/charges/[id]/route";
import { POST as stopPOST } from "@/app/api/v1/charges/[id]/stop/route";
import { GET as paymentsGET } from "@/app/api/v1/payments/route";
import { reviewListAction } from "@/app/admin/payments/actions";
import { verifyAdminCodeAction } from "@/app/admin/sign-in/actions";
import { DEMO_PEER_ID } from "@/lib/locations/registry";
import { locationAppId } from "@/lib/locations/search";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { MemoryPeerStore } from "@/lib/ocpi/store";
import { setStripeForTests } from "@/lib/payments/registry";
import { stripeClient } from "@/lib/payments/stripe";
import { configErrors, config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { setTokenStoreForTests } from "@/lib/tokens/registry";
import { MemoryTokenStore } from "@/lib/tokens/store";
import { createMockStripe, type MockStripe } from "./support/mock-stripe";
import {
  inProcessNetwork,
  installNetwork,
  LIVE_ENV,
  uninstallNetwork,
} from "./support/network";

const saved = { ...process.env };
const KEY = "sk_test_mock0123456789";
let accounts: MemoryAccountStore;
let tokens: MemoryTokenStore;
let fetchSpy: ReturnType<typeof vi.fn>;

const req = (path: string, init: RequestInit & { token?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`https://emsp.example.test${path}`, { ...init, headers });
};
const post = (
  path: string,
  body: unknown,
  init: RequestInit & { token?: string } = {},
) => req(path, { ...init, method: "POST", body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  for (const k of [
    "DEMO_MODE",
    "APP_ORIGINS",
    "TRUSTED_PROXY_HEADER",
    "STRIPE_SECRET_KEY",
    "STRIPE_PUBLISHABLE_KEY",
    "ADMIN_SECRET",
  ])
    delete process.env[k];
  accounts = new MemoryAccountStore();
  tokens = new MemoryTokenStore();
  setAccountStoreForTests(accounts);
  setTokenStoreForTests(tokens);
  setPeerStoreForTests(new MemoryPeerStore());
  resetSignInLimitsForTests();
  clearUserCacheForTests();
  requestCookies.clear();
  fetchSpy = vi.fn(() => {
    throw new Error("no network in tests");
  });
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setAccountStoreForTests(undefined);
  setTokenStoreForTests(undefined);
  setPeerStoreForTests(undefined);
  setAuthProviderForTests(undefined);
  setStripeForTests(undefined);
  vi.unstubAllGlobals();
  process.env = { ...saved };
  vi.restoreAllMocks();
});

/** Signs a driver in through the API (demo auth) and returns the session. */
async function signIn(email = "new.driver@example.com") {
  expect((await codePOST(post("/api/v1/auth/code", { email }))).status).toBe(
    202,
  );
  const res = await verifyPOST(
    post("/api/v1/auth/verify", { email, code: DEMO_CODE }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    session: { accessToken: string; refreshToken: string; expiresAt: string };
    driver: { id: string; email: string; hasCard: boolean };
  };
}

describe("passwordless sign-in (demo mode)", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
    setAuthProviderForTests(new DemoAuth());
  });

  it("emails a code, signs in, makes the account and app token once, and signs out", async () => {
    const { session, driver } = await signIn("New.Driver@Example.com ");
    expect(driver).toMatchObject({
      email: "new.driver@example.com",
      hasCard: true,
      mode: "demo",
    } as object);
    const appTokens = (await tokens.listByDriver(driver.id)).filter(
      (t) => t.type === "APP_USER",
    );
    expect(appTokens).toHaveLength(1);
    // Demo accounts pay with the demo card, which charges nothing.
    expect((await accounts.getDriver(driver.id))!.defaultPaymentMethodId).toBe(
      DEMO_CARD_ID,
    );

    // A second sign-in finds the same account and makes no second token.
    const again = await signIn("new.driver@example.com");
    expect(again.driver.id).toBe(driver.id);
    expect(await tokens.listByDriver(driver.id)).toHaveLength(1);

    const me = await meGET(req("/api/v1/me", { token: session.accessToken }));
    expect(await me.json()).toMatchObject({ driver: { id: driver.id } });

    const refreshed = await refreshPOST(
      post("/api/v1/auth/refresh", { refreshToken: session.refreshToken }),
    );
    expect(refreshed.status).toBe(200);
    expect(
      (
        await refreshPOST(
          post("/api/v1/auth/refresh", { refreshToken: session.refreshToken }),
        )
      ).status,
    ).toBe(401);

    expect(
      (
        await signOutPOST(
          req("/api/v1/auth/sign-out", {
            method: "POST",
            token: session.accessToken,
          }),
        )
      ).status,
    ).toBe(204);
    expect(
      (await meGET(req("/api/v1/me", { token: session.accessToken }))).status,
    ).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a wrong code, a bad email and a missing token", async () => {
    await codePOST(post("/api/v1/auth/code", { email: "a@example.com" }));
    const wrong = await verifyPOST(
      post("/api/v1/auth/verify", { email: "a@example.com", code: "123456" }),
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({
      error: "Wrong or expired code. Ask for a new one.",
    });
    expect(
      (await codePOST(post("/api/v1/auth/code", { email: "not-an-email" })))
        .status,
    ).toBe(400);
    expect(
      (
        await codePOST(
          req("/api/v1/auth/code", { method: "POST", body: "[1]" }),
        )
      ).status,
    ).toBe(400);
    expect((await meGET(req("/api/v1/me"))).status).toBe(401);
    expect(
      (await meGET(req("/api/v1/me", { token: "x".repeat(40) }))).status,
    ).toBe(401);
  });

  it("rate limits codes per email and per client, and attempts per email", async () => {
    const email = "limit@example.com";
    for (let i = 0; i < SIGN_IN_LIMITS.code.perEmail.limit; i++)
      expect(
        (await codePOST(post("/api/v1/auth/code", { email }))).status,
      ).toBe(202);
    const limited = await codePOST(post("/api/v1/auth/code", { email }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    // Another email is not limited by this one.
    expect(
      (
        await codePOST(
          post("/api/v1/auth/code", { email: "other@example.com" }),
        )
      ).status,
    ).toBe(202);

    process.env.TRUSTED_PROXY_HEADER = "x-client-ip";
    resetSignInLimitsForTests();
    const fromClient = (n: number) =>
      codePOST(
        post(
          "/api/v1/auth/code",
          { email: `c${n}@example.com` },
          { headers: { "x-client-ip": "203.0.113.9" } },
        ),
      );
    for (let i = 0; i < SIGN_IN_LIMITS.code.perClient.limit; i++)
      expect((await fromClient(i)).status).toBe(202);
    expect((await fromClient(99)).status).toBe(429);

    resetSignInLimitsForTests();
    await codePOST(post("/api/v1/auth/code", { email }));
    for (let i = 0; i < SIGN_IN_LIMITS.verify.perEmail.limit; i++)
      expect(
        (
          await verifyPOST(
            post("/api/v1/auth/verify", { email, code: "999999" }),
          )
        ).status,
      ).toBe(401);
    // Even the right code waits now.
    expect(
      (
        await verifyPOST(
          post("/api/v1/auth/verify", { email, code: DEMO_CODE }),
        )
      ).status,
    ).toBe(429);
  });

  it("stays limited when the caller forges X-Forwarded-For", async () => {
    const forged = (
      n: number,
      email: string,
      extra: Record<string, string> = {},
    ) =>
      codePOST(
        post(
          "/api/v1/auth/code",
          { email },
          { headers: { "x-forwarded-for": `198.51.100.${n}`, ...extra } },
        ),
      );
    // No trusted header: a raw X-Forwarded-For is never a key, so a fresh value per
    // request gets no fresh quota for an email.
    const email = "forged@example.com";
    for (let i = 0; i < SIGN_IN_LIMITS.code.perEmail.limit; i++)
      expect((await forged(i, email)).status).toBe(202);
    expect((await forged(200, email)).status).toBe(429);

    // Behind a proxy that appends the client to X-Forwarded-For, only its last entry
    // counts: a forged first entry is ignored.
    process.env.TRUSTED_PROXY_HEADER = "x-forwarded-for";
    resetSignInLimitsForTests();
    const viaProxy = (n: number) =>
      codePOST(
        post(
          "/api/v1/auth/code",
          { email: `p${n}@example.com` },
          { headers: { "x-forwarded-for": `198.51.100.${n}, 203.0.113.7` } },
        ),
      );
    for (let i = 0; i < SIGN_IN_LIMITS.code.perClient.limit; i++)
      expect((await viaProxy(i)).status).toBe(202);
    expect((await viaProxy(99)).status).toBe(429);

    // With another trusted header, X-Forwarded-For is not read at all.
    process.env.TRUSTED_PROXY_HEADER = "x-client-ip";
    resetSignInLimitsForTests();
    for (let i = 0; i < SIGN_IN_LIMITS.code.perClient.limit; i++)
      expect(
        (await forged(i, `q${i}@example.com`, { "x-client-ip": "203.0.113.8" }))
          .status,
      ).toBe(202);
    expect(
      (await forged(250, "q99@example.com", { "x-client-ip": "203.0.113.8" }))
        .status,
    ).toBe(429);
  });

  it("allows the app's web origins only, for driver data", async () => {
    process.env.APP_ORIGINS = "https://app.example.test";
    const pre = codeOPTIONS(
      req("/api/v1/auth/code", {
        headers: { Origin: "https://app.example.test" },
      }),
    );
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.test",
    );
    expect(pre.headers.get("Access-Control-Allow-Headers")).toContain(
      "Authorization",
    );
    const other = codeOPTIONS(
      req("/api/v1/auth/code", {
        headers: { Origin: "https://evil.example.test" },
      }),
    );
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const res = await codePOST(
      post(
        "/api/v1/auth/code",
        { email: "o@example.com" },
        { headers: { Origin: "https://evil.example.test" } },
      ),
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("charges through the API: start, poll, stop and history, nothing sent anywhere", async () => {
    const { session } = await signIn();
    const token = session.accessToken;
    const locationId = locationAppId({
      peerId: DEMO_PEER_ID,
      countryCode: "ZZ",
      partyId: "MCK",
      id: "LOC1",
    });
    const start = await chargePOST(
      post(
        "/api/v1/charges",
        {
          requestId: "app-req-0001",
          locationId,
          evseUid: "LOC1-1",
          connectorId: "1",
        },
        { token },
      ),
    );
    expect(start.status).toBe(201);
    const body = await start.json();
    expect(body.command).toMatchObject({
      status: "succeeded",
      peerMessage: "Demo mode: nothing was sent to a charger.",
    });
    expect(body.payment).toMatchObject({
      status: "held",
      holdAmount: 2500,
      demo: true,
    });
    const poll = await chargeGET(
      req(`/api/v1/charges/${body.command.id}`, { token }),
      params(body.command.id),
    );
    expect(await poll.json()).toMatchObject({
      command: { id: body.command.id },
      payment: { status: "held" },
    });
    // Another driver cannot see it.
    const other = await signIn("other.driver@example.com");
    expect(
      (
        await chargeGET(
          req(`/api/v1/charges/${body.command.id}`, {
            token: other.session.accessToken,
          }),
          params(body.command.id),
        )
      ).status,
    ).toBe(404);
    // No session yet: nothing to stop.
    expect(
      (
        await stopPOST(
          post(
            `/api/v1/charges/${body.command.id}/stop`,
            { requestId: "app-req-0002" },
            { token },
          ),
          params(body.command.id),
        )
      ).status,
    ).toBe(409);
    const history = await (
      await paymentsGET(req("/api/v1/payments", { token }))
    ).json();
    expect(history.payments).toHaveLength(1);
    expect(JSON.stringify(history)).not.toContain("pm_");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows the demo card and saves no card", async () => {
    const { session } = await signIn();
    const token = session.accessToken;
    const cards = await (
      await cardsGET(req("/api/v1/cards", { token }))
    ).json();
    expect(cards).toMatchObject({
      mode: "demo",
      cards: [{ id: DEMO_CARD_ID, last4: "4242", isDefault: true }],
    });
    const setup = await (
      await setupPOST(post("/api/v1/cards/setup", {}, { token }))
    ).json();
    expect(setup).toMatchObject({
      mode: "demo",
      setupIntentClientSecret: null,
    });
    expect(
      (
        await defaultPUT(
          req("/api/v1/cards/default", {
            method: "PUT",
            body: JSON.stringify({ paymentMethodId: "pm_other" }),
            token,
          }),
        )
      ).status,
    ).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Supabase Auth, over HTTP", () => {
  const calls: { path: string; headers: Headers; body: unknown }[] = [];
  const user = {
    id: "6b1c4c1e-8c47-4f5e-9d55-0f1f0f8d2b11",
    email: "driver@example.com",
  };
  const auth = () => {
    const net = inProcessNetwork({
      "db.example.test": async (r) => {
        const url = new URL(r.url);
        const body = r.method === "POST" ? await r.json() : undefined;
        calls.push({
          path: `${url.pathname}${url.search}`,
          headers: r.headers,
          body,
        });
        const session = {
          access_token: "at-0123456789abcdef",
          refresh_token: "rt-0123456789",
          expires_at: 2_000_000_000,
          user,
        };
        if (url.pathname === "/auth/v1/otp") return Response.json({});
        if (url.pathname === "/auth/v1/verify")
          return (body as { token?: string; token_hash?: string }).token ===
            "123456" ||
            (body as { token_hash?: string }).token_hash ===
              "hash0123456789abcdef"
            ? Response.json(session)
            : Response.json({ error: "otp_expired" }, { status: 403 });
        if (url.pathname === "/auth/v1/user")
          return r.headers.get("authorization") === "Bearer at-0123456789abcdef"
            ? Response.json(user)
            : Response.json({}, { status: 401 });
        if (url.pathname === "/auth/v1/token")
          return Response.json({
            ...session,
            access_token: "at-new-0123456789",
          });
        if (url.pathname === "/auth/v1/logout")
          return new Response(null, { status: 204 });
        return Response.json({}, { status: 404 });
      },
    });
    installNetwork(net.transport);
    return new SupabaseAuth("https://db.example.test", "test-service-role-key");
  };
  beforeEach(() => {
    Object.assign(process.env, LIVE_ENV, {
      AUTH_REDIRECT_URL: "yournetwork://sign-in",
    });
    calls.length = 0;
  });
  afterEach(() => uninstallNetwork());

  it("sends the code, verifies a code or a link's token hash, and reads the user", async () => {
    const a = auth();
    setAuthProviderForTests(a);
    expect(
      (
        await codePOST(
          post("/api/v1/auth/code", { email: "Driver@example.com" }),
        )
      ).status,
    ).toBe(202);
    expect(calls[0]).toMatchObject({
      path: `/auth/v1/otp?redirect_to=${encodeURIComponent("yournetwork://sign-in")}`,
      body: { email: "driver@example.com", create_user: true },
    });
    expect(calls[0].headers.get("apikey")).toBe("test-service-role-key");

    const res = await verifyPOST(
      post("/api/v1/auth/verify", {
        email: "driver@example.com",
        code: "123456",
      }),
    );
    expect(await res.json()).toMatchObject({
      session: { accessToken: "at-0123456789abcdef" },
      driver: { id: user.id },
    });
    expect(calls.at(-1)!.body).toEqual({
      type: "email",
      email: "driver@example.com",
      token: "123456",
    });
    expect(await a.verify({ tokenHash: "hash0123456789abcdef" })).toMatchObject(
      { user },
    );
    expect(
      await a.verify({ email: "driver@example.com", code: "000000" }),
    ).toBeNull();
    expect(await a.getUser("at-0123456789abcdef")).toEqual(user);
    expect(await a.getUser("at-other")).toBeNull();
    expect(await a.refresh("rt-0123456789")).toMatchObject({
      accessToken: "at-new-0123456789",
    });
  });

  it("answers the same when sending fails, so it never tells who has an account", async () => {
    setAuthProviderForTests({
      ...new DemoAuth(),
      sendCode: async () => {
        throw new Error("Auth request failed: POST otp (HTTP 400)");
      },
    } as unknown as DemoAuth);
    const res = await codePOST(
      post("/api/v1/auth/code", { email: "x@example.com" }),
    );
    expect(res.status).toBe(202);
  });

  it("makes one account and one app token for concurrent first sign-ins", async () => {
    const d = {
      auth: new DemoAuth(),
      accounts,
      tokens,
      peers: new MemoryPeerStore(),
    };
    await Promise.all([
      ensureAccount(user, d),
      ensureAccount(user, d),
      ensureAccount(user, d),
    ]);
    expect(accounts.drivers.size).toBe(1);
    expect(await tokens.listByDriver(user.id)).toHaveLength(1);
  });
});

describe("saved cards on the network's Stripe account", () => {
  let stripe: MockStripe;
  let token: string;
  let driverId: string;

  beforeEach(async () => {
    Object.assign(process.env, LIVE_ENV, {
      STRIPE_SECRET_KEY: KEY,
      STRIPE_PUBLISHABLE_KEY: "pk_test_mock123",
    });
    stripe = createMockStripe();
    installNetwork(
      inProcessNetwork({ "api.stripe.com": (r) => stripe.handle(r) }).transport,
    );
    setStripeForTests(stripeClient(KEY, { retryDelayMs: 0 }));
    const auth = new DemoAuth();
    setAuthProviderForTests(auth);
    await auth.sendCode("card.driver@example.com");
    const session = (await auth.verify({
      email: "card.driver@example.com",
      code: DEMO_CODE,
    }))!;
    token = session.accessToken;
    driverId = session.user.id;
    await accounts.ensureDriver(
      driverId,
      "card.driver@example.com",
      new Date().toISOString(),
    );
  });
  afterEach(() => uninstallNetwork());

  it("makes one Customer, a SetupIntent and an ephemeral key for the PaymentSheet", async () => {
    const setup = (id: string) =>
      setupPOST(
        post(
          "/api/v1/cards/setup",
          { requestId: id, stripeVersion: "2024-06-20" },
          { token },
        ),
      );
    const [a, b] = await Promise.all([
      setup("setup-0001"),
      setup("setup-0002"),
    ]);
    const one = await a.json();
    expect(one).toMatchObject({
      mode: "live",
      publishableKey: "pk_test_mock123",
    });
    expect(one.setupIntentClientSecret).toMatch(/_secret_/);
    expect(one.ephemeralKeySecret).toMatch(/^ek_test_/);
    expect((await b.json()).customerId).toBe(one.customerId);
    // One Customer for the driver, whoever got there first: the key is the driver's.
    expect(stripe.state.customers.size).toBe(1);
    expect(
      new Set(stripe.callsTo(/^\/v1\/customers$/).map((c) => c.key)),
    ).toEqual(new Set([`emsp:driver:${driverId}:customer`]));
    expect(stripe.callsTo(/ephemeral_keys/)[0].version).toBe("2024-06-20");
    expect((await accounts.getDriver(driverId))!.stripeCustomerId).toBe(
      one.customerId,
    );
    // The app's SDK version is required for the ephemeral key.
    expect(
      (
        await setupPOST(
          post("/api/v1/cards/setup", { requestId: "setup-0003" }, { token }),
        )
      ).status,
    ).toBe(400);
  });

  it("chooses and removes only the driver's own cards, and keeps no card data", async () => {
    await (
      await setupPOST(
        post(
          "/api/v1/cards/setup",
          { requestId: "setup-0101", stripeVersion: "2024-06-20" },
          { token },
        ),
      )
    ).json();
    const customer = (await accounts.getDriver(driverId))!.stripeCustomerId!;
    const mine = stripe.attachCard(customer, "visa");
    const theirs = stripe.attachCard(
      stripe.customer("someone@example.com"),
      "visa",
    );
    const choose = (pm: string) =>
      defaultPUT(
        req("/api/v1/cards/default", {
          method: "PUT",
          body: JSON.stringify({ paymentMethodId: pm }),
          token,
        }),
      );
    expect((await choose(theirs)).status).toBe(404);
    expect((await choose("not-a-card")).status).toBe(404);
    expect(await (await choose(mine)).json()).toEqual({
      defaultPaymentMethodId: mine,
    });
    const list = await (await cardsGET(req("/api/v1/cards", { token }))).json();
    expect(list.cards).toEqual([
      {
        id: mine,
        brand: "visa",
        last4: "4242",
        expMonth: 12,
        expYear: 2030,
        isDefault: true,
      },
    ]);
    // Only IDs are stored.
    expect(JSON.stringify(accounts.drivers.get(driverId))).not.toContain(
      "4242",
    );
    expect(
      (
        await cardDELETE(
          req(`/api/v1/cards/${theirs}`, { method: "DELETE", token }),
          params(theirs),
        )
      ).status,
    ).toBe(404);
    expect(
      await (
        await cardDELETE(
          req(`/api/v1/cards/${mine}`, { method: "DELETE", token }),
          params(mine),
        )
      ).json(),
    ).toEqual({
      defaultPaymentMethodId: null,
    });
    expect(stripe.callsTo(/detach$/).map((c) => c.key)).toEqual([
      `emsp:driver:${driverId}:detach:${mine}`,
    ]);
  });

  it("answers 503 when payments are not set up", async () => {
    setStripeForTests(null);
    expect(
      (
        await setupPOST(
          post(
            "/api/v1/cards/setup",
            { requestId: "setup-0201", stripeVersion: "2024-06-20" },
            { token },
          ),
        )
      ).status,
    ).toBe(503);
  });
});

describe("admin sign-in and the admin role table", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
  });

  it("lets listed admins in, read-only viewers look, and nobody else", async () => {
    const auth = new DemoAuth();
    setAuthProviderForTests(auth);
    await auth.sendCode("admin@example.com");
    await auth.sendCode("viewer@example.com");
    await auth.sendCode("driver@example.com");
    accounts.admins.set(auth.users.get("admin@example.com")!.id, "admin");
    accounts.admins.set(auth.users.get("viewer@example.com")!.id, "viewer");
    const form = (o: Record<string, string>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries(o)) f.set(k, v);
      return f;
    };

    expect(
      await verifyAdminCodeAction(
        {},
        form({ email: "driver@example.com", code: DEMO_CODE }),
      ),
    ).toEqual({
      ok: false,
      message: "This account is not an admin.",
    });
    expect(requestCookies.has(ADMIN_COOKIE)).toBe(false);
    // Without a session or ADMIN_SECRET, admin actions are refused.
    expect((await reviewListAction({}, form({}))).ok).toBe(false);

    expect(
      await verifyAdminCodeAction(
        {},
        form({ email: "viewer@example.com", code: DEMO_CODE }),
      ),
    ).toMatchObject({ ok: true });
    expect(await reviewListAction({}, form({}))).toEqual({
      ok: false,
      message: "Your admin role is read-only.",
    });

    expect(
      await verifyAdminCodeAction(
        {},
        form({ email: "admin@example.com", code: DEMO_CODE }),
      ),
    ).toMatchObject({ ok: true });
    const token = requestCookies.get(ADMIN_COOKIE)!;
    expect(await adminFromToken(token)).toMatchObject({
      email: "admin@example.com",
      role: "admin",
    });
    expect(await reviewListAction({}, form({}))).toEqual({
      ok: true,
      message: "Nothing to review.",
      payments: [],
    });
  });
});

describe("payment settings", () => {
  it("validates the Stripe, hold and receipt variables by name, never value", () => {
    Object.assign(process.env, LIVE_ENV);
    expect(isDemo()).toBe(false);
    expect(config.holdAmounts).toEqual({ EUR: 2500, USD: 2500, GBP: 2500 });
    expect(config.incrementalAuth).toEqual({ enabled: false, atPercent: 80 });
    Object.assign(process.env, {
      STRIPE_SECRET_KEY: "pk_live_wrongkind",
      HOLD_AMOUNTS: "EUR:0",
      STRIPE_INCREMENTAL_AUTH: "maybe",
      HOLD_INCREMENT_AT_PERCENT: "99",
      APP_ORIGINS: "http://app.example.test",
    });
    const errors = configErrors().join(" ");
    for (const name of [
      "STRIPE_SECRET_KEY",
      "HOLD_AMOUNTS",
      "STRIPE_INCREMENTAL_AUTH",
      "HOLD_INCREMENT_AT_PERCENT",
      "APP_ORIGINS",
    ])
      expect(errors).toContain(name);
    expect(errors).not.toContain("pk_live_wrongkind");
    expect(isDemo()).toBe(true);
    Object.assign(process.env, {
      STRIPE_SECRET_KEY: KEY,
      HOLD_AMOUNTS: "eur:3000, jpy:500",
      STRIPE_INCREMENTAL_AUTH: "on",
      HOLD_INCREMENT_AT_PERCENT: "75",
      APP_ORIGINS: "https://app.example.test,https://web.example.test",
    });
    expect(configErrors()).toEqual([]);
    expect(config.holdAmounts).toEqual({ EUR: 3000, JPY: 500 });
    expect(config.incrementalAuth).toEqual({ enabled: true, atPercent: 75 });
    expect(config.appOrigins).toEqual([
      "https://app.example.test",
      "https://web.example.test",
    ]);
  });
});
