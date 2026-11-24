import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Server actions read the request's cookies and headers; tests set them here.
vi.mock(
  "next/headers",
  async () => (await import("./support/request")).nextHeaders,
);

import { reviewListAction } from "@/app/admin/payments/actions";
import { setupStatusAction } from "@/app/admin/setup/actions";
import {
  adminSecretSignInAction,
  requestAdminCodeAction,
  signOutAdminAction,
  verifyAdminCodeAction,
  verifyAdminLinkAction,
} from "@/app/admin/sign-in/actions";
import { ADMIN_COOKIE } from "@/lib/accounts/admin-session";
import { clearUserCacheForTests } from "@/lib/accounts/api";
import {
  AuthRateLimitedError,
  DEMO_CODE,
  DemoAuth,
  SupabaseAuth,
  type AuthProvider,
  type AuthSession,
  type Proof,
} from "@/lib/accounts/auth";
import {
  setAccountStoreForTests,
  setAuthProviderForTests,
} from "@/lib/accounts/registry";
import {
  isTokenHash,
  requestCode,
  RESEND_COOLDOWN_MS,
  resetSignInLimitsForTests,
  SIGN_IN_LIMITS,
  SignInError,
  verifyProof,
} from "@/lib/accounts/sign-in";
import { MemoryAccountStore } from "@/lib/accounts/store";
import {
  ADMIN_LIMIT,
  ADMIN_SECRET_COOKIE,
  checkAdminSecret,
  checkSecretSession,
  issueSecretSession,
  resetAdminLimitForTests,
  SECRET_SESSION_MS,
} from "@/lib/server/admin";
import { setPaymentStoreForTests } from "@/lib/payments/registry";
import { MemoryPaymentStore } from "@/lib/payments/store";
import {
  inProcessNetwork,
  installNetwork,
  uninstallNetwork,
  LIVE_ENV,
} from "./support/network";
import {
  cookieOptions,
  requestCookies,
  requestHeaders,
  resetRequest,
  signInWithSecret,
} from "./support/request";

const SECRET = "admin-secret-".repeat(3);
const saved = { ...process.env };
const HASH = "hash0123456789abcdef";
let accounts: MemoryAccountStore;

const form = (fields: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** Sign-in that knows two users, by code "123456" or by one link each. */
const ANA = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "ana@example.com",
};
const BEN = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "ben@example.com",
};
function fakeAuth(over: Partial<AuthProvider> = {}) {
  const sent: { email: string; redirectTo?: string }[] = [];
  const signedOut: string[] = [];
  const users = [ANA, BEN];
  const session = (user: typeof ANA): AuthSession => ({
    accessToken: `at-${user.id}`,
    refreshToken: `rt-${user.id}`,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    user,
  });
  const auth: AuthProvider = {
    sendCode: async (email, redirectTo) => {
      sent.push({ email, redirectTo });
    },
    verify: async (proof: Proof) => {
      if ("tokenHash" in proof)
        return proof.tokenHash === HASH ? session(ANA) : null;
      const user = users.find((u) => u.email === proof.email);
      return user && proof.code === "123456" ? session(user) : null;
    },
    refresh: async () => null,
    getUser: async (token) => users.find((u) => `at-${u.id}` === token) ?? null,
    signOut: async (token) => {
      signedOut.push(token);
    },
    ...over,
  };
  setAuthProviderForTests(auth);
  return { auth, sent, signedOut };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
  for (const k of [
    "DEMO_MODE",
    "TRUSTED_PROXY_HEADER",
    "VERCEL",
    "ADMIN_SECRET",
  ])
    delete process.env[k];
  // Live mode: the admin list is the account store's.
  Object.assign(process.env, LIVE_ENV);
  accounts = new MemoryAccountStore();
  setAccountStoreForTests(accounts);
  setPaymentStoreForTests(new MemoryPaymentStore());
  resetSignInLimitsForTests();
  resetAdminLimitForTests();
  clearUserCacheForTests();
  resetRequest();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setAccountStoreForTests(undefined);
  setAuthProviderForTests(undefined);
  setPaymentStoreForTests(undefined);
  uninstallNetwork();
  resetRequest();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const refusal = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (e) {
    if (e instanceof SignInError) return e;
    throw e;
  }
  throw new Error("expected a SignInError");
};

describe("a sign-in limit says whose it is and how long it lasts", () => {
  const deps = () => ({ auth: fakeAuth().auth });

  it("this server's limit per email address, with the wait until the oldest code is an hour old", async () => {
    const d = deps();
    const { limit, windowMs } = SIGN_IN_LIMITS.code.perEmail;
    for (let i = 0; i < limit; i += 1) {
      await requestCode({ email: ANA.email }, null, d);
      vi.advanceTimersByTime(60_000);
    }
    const e = await refusal(() => requestCode({ email: ANA.email }, null, d));
    const wait = (windowMs - limit * 60_000) / 1000;
    expect(e.httpStatus).toBe(429);
    expect(e.retryAfter).toBe(wait);
    expect(e.limit).toEqual({ on: "code", source: "email", retryAfter: wait });
    // Another address is not limited by this one.
    await requestCode({ email: BEN.email }, null, d);
  });

  it("this server's limit per client address", async () => {
    const d = deps();
    const { limit } = SIGN_IN_LIMITS.code.perClient;
    for (let i = 0; i < limit; i += 1)
      await requestCode({ email: `c${i}@example.com` }, "203.0.113.9", d);
    const e = await refusal(() =>
      requestCode({ email: "next@example.com" }, "203.0.113.9", d),
    );
    expect(e.limit).toEqual({ on: "code", source: "client", retryAfter: 3600 });
    // Another client, and a request without a trusted address, have their own count.
    await requestCode({ email: "next@example.com" }, "203.0.113.10", d);
    await requestCode({ email: "other@example.com" }, null, d);
  });

  it("this server's limit in total", async () => {
    const d = deps();
    for (let i = 0; i < SIGN_IN_LIMITS.code.total.limit; i += 1)
      await requestCode({ email: `t${i}@example.com` }, null, d);
    const e = await refusal(() =>
      requestCode({ email: "next@example.com" }, null, d),
    );
    expect(e.limit).toEqual({ on: "code", source: "total", retryAfter: 3600 });
  });

  it("names the limit that lasts longest when two refuse at once", async () => {
    const d = deps();
    const { limit } = SIGN_IN_LIMITS.code.perClient;
    // The client's count fills first; ten minutes later the address's does.
    for (let i = 0; i < limit; i += 1)
      await requestCode({ email: `c${i}@example.com` }, "203.0.113.9", d);
    vi.advanceTimersByTime(10 * 60_000);
    for (let i = 0; i < SIGN_IN_LIMITS.code.perEmail.limit; i += 1)
      await requestCode({ email: ANA.email }, null, d);
    const e = await refusal(() =>
      requestCode({ email: ANA.email }, "203.0.113.9", d),
    );
    expect(e.limit).toEqual({ on: "code", source: "email", retryAfter: 3600 });
  });

  it("the email service's limit, with its Retry-After when it sends one and without a wait when it does not", async () => {
    for (const [header, known] of [
      ["120", 120],
      [undefined, null],
      ["soon", null],
      ["0", null],
    ] as const) {
      resetSignInLimitsForTests();
      const net = inProcessNetwork({
        "db.example.test": async () =>
          Response.json(
            { code: "over_email_send_rate_limit" },
            { status: 429, headers: header ? { "Retry-After": header } : {} },
          ),
      });
      installNetwork(net.transport);
      const auth = new SupabaseAuth(
        "https://db.example.test",
        "test-service-role-key",
      );
      const e = await refusal(() =>
        requestCode({ email: ANA.email }, null, { auth }),
      );
      expect(e.limit).toEqual({
        on: "code",
        source: "email_service",
        retryAfter: known,
      });
      // The API's Retry-After header keeps its minute when the service gave none.
      expect(e.retryAfter).toBe(known ?? 60);
      const v = await refusal(() =>
        verifyProof({ email: ANA.email, code: "123456" }, null, { auth }),
      );
      expect(v.limit).toEqual({
        on: "verify",
        source: "email_service",
        retryAfter: known,
      });
    }
  });

  it("the limits on tries: per address, per client and for one link", async () => {
    const d = deps();
    const { perEmail, perClient } = SIGN_IN_LIMITS.verify;
    for (let i = 0; i < perEmail.limit; i += 1)
      expect(
        (
          await refusal(() =>
            verifyProof({ email: ANA.email, code: "999999" }, null, d),
          )
        ).httpStatus,
      ).toBe(401);
    // Even the right code waits now.
    const e = await refusal(() =>
      verifyProof({ email: ANA.email, code: "123456" }, null, d),
    );
    expect(e.limit).toEqual({
      on: "verify",
      source: "email",
      retryAfter: perEmail.windowMs / 1000,
    });

    resetSignInLimitsForTests();
    for (let i = 0; i < perClient.limit; i += 1)
      await refusal(() =>
        verifyProof(
          { email: `v${i}@example.com`, code: "999999" },
          "203.0.113.9",
          d,
        ),
      );
    const c = await refusal(() =>
      verifyProof({ email: ANA.email, code: "123456" }, "203.0.113.9", d),
    );
    expect(c.limit?.source).toBe("client");

    // A link's token hash has its own count, like an address.
    resetSignInLimitsForTests();
    const wrong = "wrong0123456789abcdef";
    for (let i = 0; i < perEmail.limit; i += 1)
      await refusal(() => verifyProof({ tokenHash: wrong }, null, d));
    expect(
      (await refusal(() => verifyProof({ tokenHash: wrong }, null, d))).limit,
    ).toMatchObject({ on: "verify", source: "email" });
    expect((await verifyProof({ tokenHash: HASH }, null, d)).user).toEqual(ANA);
  });
});

describe("the resend cooldown for an address", () => {
  it("tells how long until another code may be asked, and refuses one asked sooner without counting it", async () => {
    const { auth, sent } = fakeAuth();
    const admin = { resendCooldown: true };
    const cooldown = RESEND_COOLDOWN_MS / 1000;
    expect(
      await requestCode({ email: ANA.email }, null, { auth }, admin),
    ).toEqual({ resendAfter: cooldown });

    vi.advanceTimersByTime(8_000);
    const e = await refusal(() =>
      requestCode({ email: "Ana@Example.com " }, null, { auth }, admin),
    );
    expect(e.limit).toEqual({
      on: "code",
      source: "cooldown",
      retryAfter: cooldown - 8,
    });
    expect(e.retryAfter).toBe(cooldown - 8);
    expect(sent).toHaveLength(1);
    // Another address has its own cooldown.
    expect(
      await requestCode({ email: BEN.email }, null, { auth }, admin),
    ).toEqual({ resendAfter: cooldown });

    // The refused request used none of the hourly count: after each cooldown a code
    // goes out, up to the hourly limit, and the last answer carries the hourly wait.
    const { limit, windowMs } = SIGN_IN_LIMITS.code.perEmail;
    let last = { resendAfter: 0 };
    for (let i = 1; i < limit; i += 1) {
      vi.advanceTimersByTime(RESEND_COOLDOWN_MS);
      last = await requestCode({ email: ANA.email }, null, { auth }, admin);
    }
    expect(sent.filter((s) => s.email === ANA.email)).toHaveLength(limit);
    expect(last.resendAfter).toBe(windowMs / 1000 - 8 - (limit - 1) * cooldown);
    vi.advanceTimersByTime(RESEND_COOLDOWN_MS);
    expect(
      (
        await refusal(() =>
          requestCode({ email: ANA.email }, null, { auth }, admin),
        )
      ).limit,
    ).toMatchObject({ source: "email" });
  });

  it("is the admin page's: the driver API asks as before, with no cooldown", async () => {
    const { auth, sent } = fakeAuth();
    expect(await requestCode({ email: ANA.email }, null, { auth })).toEqual({
      resendAfter: 0,
    });
    expect(await requestCode({ email: ANA.email }, null, { auth })).toEqual({
      resendAfter: 0,
    });
    expect(sent).toHaveLength(2);
  });

  it("reaches the page: the answer after a code, and the refusal with its source and wait", async () => {
    const { sent } = fakeAuth();
    const first = await requestAdminCodeAction(
      {},
      form({ email: " Ana@example.com" }),
    );
    expect(first).toEqual({
      ok: true,
      message:
        "If the address can sign in, an email with a code is on its way.",
      email: ANA.email,
      resendAfter: RESEND_COOLDOWN_MS / 1000,
    });
    // The email's link, if the template has one, leads back to the sign-in page.
    expect(sent).toEqual([
      {
        email: ANA.email,
        redirectTo: "https://emsp.example.test/admin/sign-in",
      },
    ]);
    // An address nobody has an account for gets the same answer.
    expect(
      await requestAdminCodeAction({}, form({ email: "nobody@example.com" })),
    ).toEqual({ ...first, email: "nobody@example.com" });

    vi.advanceTimersByTime(15_000);
    expect(
      await requestAdminCodeAction({}, form({ email: ANA.email })),
    ).toEqual({
      ok: false,
      message: "Too many sign-in attempts. Try again later.",
      code: "sign_in_limited",
      limit: { on: "code", source: "cooldown", retryAfter: 45 },
    });
  });

  it("names the email service's limit to the page with its own code", async () => {
    fakeAuth({
      sendCode: async () => {
        throw new AuthRateLimitedError(300);
      },
    });
    expect(
      await requestAdminCodeAction({}, form({ email: ANA.email })),
    ).toMatchObject({
      ok: false,
      code: "email_service_limited",
      limit: { on: "code", source: "email_service", retryAfter: 300 },
    });
  });
});

describe("a right code for an address that is not an admin", () => {
  const right = () =>
    verifyAdminCodeAction({}, form({ email: ANA.email, code: "123456" }));

  it("says the admin list is empty, as a yes or no and nothing else", async () => {
    const { signedOut } = fakeAuth();
    const answer = await right();
    expect(answer).toEqual({
      ok: false,
      message: "This account is not an admin.",
      code: "not_an_admin",
      email: ANA.email,
      noAdmins: true,
    });
    // Not signed in: no cookie, and the session that proved the address is ended.
    expect(requestCookies.size).toBe(0);
    expect(signedOut).toEqual([`at-${ANA.id}`]);
  });

  it("says the list is not empty without saying who is on it or how many", async () => {
    fakeAuth();
    accounts.admins.set(BEN.id, "admin");
    accounts.admins.set("33333333-3333-4333-8333-333333333333", "viewer");
    const count = vi.spyOn(accounts, "countAdmins");
    const answer = await right();
    expect(answer).toEqual({
      ok: false,
      message: "This account is not an admin.",
      code: "not_an_admin",
      email: ANA.email,
      noAdmins: false,
    });
    const sent = JSON.stringify(answer);
    for (const other of [BEN.id, BEN.email, "33333333", "viewer", "2"])
      expect(sent).not.toContain(other);
    // One row at most is read for it: the list is never counted.
    expect(count).not.toHaveBeenCalled();
  });

  it("says nothing about the list before the address is proved", async () => {
    fakeAuth();
    for (const fields of [
      { email: ANA.email, code: "999999" },
      { email: "nobody@example.com", code: "123456" },
      { email: ANA.email, code: "" },
      { email: "not an email", code: "123456" },
    ]) {
      const answer = await verifyAdminCodeAction({}, form(fields));
      expect(answer.ok).toBe(false);
      expect(Object.keys(answer).sort()).toEqual(["message", "ok"]);
    }
    // Nor does asking for a code.
    expect(
      Object.keys(await requestAdminCodeAction({}, form({ email: ANA.email }))),
    ).not.toContain("noAdmins");
  });

  it("leaves it out when the list cannot be read, and in demo mode", async () => {
    fakeAuth();
    vi.spyOn(accounts, "hasAdmin").mockRejectedValue(new Error("down"));
    expect(Object.keys(await right())).not.toContain("noAdmins");

    process.env.DEMO_MODE = "true";
    resetSignInLimitsForTests();
    const auth = new DemoAuth();
    setAuthProviderForTests(auth);
    await auth.sendCode(ANA.email);
    const demo = await verifyAdminCodeAction(
      {},
      form({ email: ANA.email, code: DEMO_CODE }),
    );
    expect(demo).toMatchObject({ ok: false, code: "not_an_admin" });
    expect(Object.keys(demo)).not.toContain("noAdmins");
  });

  it("lets an admin in, with the admin cookie's flags", async () => {
    fakeAuth();
    accounts.admins.set(ANA.id, "admin");
    vi.stubEnv("NODE_ENV", "production");
    expect(await right()).toEqual({
      ok: true,
      message: "Signed in as ana@example.com (admin).",
    });
    expect(requestCookies.get(ADMIN_COOKIE)).toBe(`at-${ANA.id}`);
    expect(cookieOptions.get(ADMIN_COOKIE)).toMatchObject({
      httpOnly: true,
      sameSite: "strict",
      secure: true,
      path: "/",
    });
  });
});

describe("the emailed link on admin sign-in", () => {
  const link = (tokenHash: string) =>
    verifyAdminLinkAction({}, form({ tokenHash }));

  it("signs an admin in with the link's token hash", async () => {
    fakeAuth();
    accounts.admins.set(ANA.id, "admin");
    expect(await link(HASH)).toEqual({
      ok: true,
      message: "Signed in as ana@example.com (admin).",
    });
    expect(requestCookies.get(ADMIN_COOKIE)).toBe(`at-${ANA.id}`);
    expect(await reviewListAction({}, form())).toMatchObject({ ok: true });
  });

  it("holds a link to the admin list like a code, and says whose address it proved", async () => {
    const { signedOut } = fakeAuth();
    expect(await link(HASH)).toEqual({
      ok: false,
      message: "This account is not an admin.",
      code: "not_an_admin",
      email: ANA.email,
      noAdmins: true,
    });
    expect(requestCookies.size).toBe(0);
    expect(signedOut).toEqual([`at-${ANA.id}`]);
    accounts.admins.set(ANA.id, "viewer");
    expect(await link(HASH)).toMatchObject({
      ok: true,
      message: "Signed in as ana@example.com (read only).",
    });
  });

  it("refuses a wrong, used, malformed or missing token hash with one sentence, and never asks the email service for a malformed one", async () => {
    const verify = vi.fn(async () => null);
    fakeAuth({ verify });
    const refused = {
      ok: false,
      message: "This sign-in link is invalid or has expired.",
    };
    expect(await link("wrong0123456789abcdef")).toEqual(refused);
    expect(verify).toHaveBeenCalledTimes(1);
    for (const bad of [
      "",
      "short",
      "has spaces 0123456789",
      "a".repeat(129),
      "../../etc/passwd0123",
    ])
      expect(await link(bad)).toEqual(refused);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(requestCookies.size).toBe(0);
  });

  it("limits tries of links per client", async () => {
    fakeAuth();
    process.env.TRUSTED_PROXY_HEADER = "x-client-ip";
    requestHeaders.set("x-client-ip", "203.0.113.9");
    for (let i = 0; i < SIGN_IN_LIMITS.verify.perClient.limit; i += 1)
      expect((await link(`wrong${i}-0123456789abcdef`)).limit).toBeUndefined();
    expect(await link(HASH)).toMatchObject({
      ok: false,
      code: "sign_in_limited",
      limit: { on: "verify", source: "client" },
    });
    expect(requestCookies.size).toBe(0);
  });

  it("knows the form of a token hash, for the page that reads the link", () => {
    expect(isTokenHash(HASH)).toBe(true);
    for (const bad of [
      undefined,
      null,
      "",
      "short",
      ["a".repeat(20)],
      "<script>0123456789abc",
      "a".repeat(129),
    ])
      expect(isTokenHash(bad)).toBe(false);
  });
});

describe("ADMIN_SECRET is exchanged for an admin-secret session cookie", () => {
  beforeEach(() => {
    process.env.ADMIN_SECRET = SECRET;
  });
  const exchange = (secret: string) =>
    adminSecretSignInAction({}, form({ secret }));
  const list = (fields: Record<string, string> = {}) =>
    reviewListAction({}, form(fields));

  it("sets the cookie with the admin cookie's flags, for an hour, without the secret in it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await exchange(SECRET)).toEqual({
      ok: true,
      message: "Signed in with the admin secret.",
    });
    const value = requestCookies.get(ADMIN_SECRET_COOKIE)!;
    expect(cookieOptions.get(ADMIN_SECRET_COOKIE)).toEqual({
      httpOnly: true,
      sameSite: "strict",
      secure: true,
      path: "/",
      expires: new Date(Date.now() + SECRET_SESSION_MS),
    });
    expect(SECRET_SESSION_MS).toBe(60 * 60 * 1000);
    expect(value).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(value).not.toContain(SECRET);
    expect(
      Buffer.from(value.split(".")[2], "base64url").toString("latin1"),
    ).not.toContain(SECRET);
    // The same flags as the email sign-in's cookie: one function makes both.
    fakeAuth();
    accounts.admins.set(ANA.id, "admin");
    await verifyAdminCodeAction({}, form({ email: ANA.email, code: "123456" }));
    const { expires: _a, ...secretFlags } =
      cookieOptions.get(ADMIN_SECRET_COOKIE)!;
    const { expires: _b, ...emailFlags } = cookieOptions.get(ADMIN_COOKIE)!;
    expect(secretFlags).toEqual(emailFlags);
  });

  it("is not Secure outside production, so sign-in works on http://localhost", async () => {
    await exchange(SECRET);
    expect(cookieOptions.get(ADMIN_SECRET_COOKIE)).toMatchObject({
      httpOnly: true,
      sameSite: "strict",
      secure: false,
    });
  });

  it("opens admin actions with the cookie alone: no form carries the secret", async () => {
    expect(await list()).toMatchObject({ ok: false, code: "signed_out" });
    // The secret in a form field is no longer a way in.
    expect(await list({ adminSecret: SECRET })).toMatchObject({
      ok: false,
      code: "signed_out",
    });
    await exchange(SECRET);
    expect(await list()).toEqual({
      ok: true,
      message: "Nothing to review.",
      payments: [],
    });
    expect((await setupStatusAction({}, form())).ok).toBe(true);
  });

  it("refuses a wrong secret and sets nothing", async () => {
    for (const wrong of ["", "wrong", `${SECRET}x`, SECRET.slice(1)]) {
      resetAdminLimitForTests();
      expect(await exchange(wrong)).toEqual({
        ok: false,
        message: "That is not this server's admin secret.",
        code: "wrong_secret",
        nextStep:
          "Check the value of ADMIN_SECRET in the server's settings, or sign in by email instead.",
      });
    }
    expect(requestCookies.size).toBe(0);
    expect(await list()).toMatchObject({ ok: false, code: "signed_out" });
  });

  it("is off without ADMIN_SECRET, and with one under 32 characters", async () => {
    for (const unset of ["", "short"]) {
      process.env.ADMIN_SECRET = unset;
      resetAdminLimitForTests();
      for (const tried of [unset, SECRET])
        expect(await exchange(tried)).toMatchObject({
          ok: false,
          code: "wrong_secret",
        });
      expect(issueSecretSession()).toBeNull();
    }
    expect(requestCookies.size).toBe(0);
  });

  it("keeps the lockout counts: 5 wrong secrets per client, 50 in total, per 15 minutes", async () => {
    expect(ADMIN_LIMIT).toEqual({
      windowMs: 15 * 60 * 1000,
      perClient: 5,
      total: 50,
    });
    process.env.TRUSTED_PROXY_HEADER = "x-client-ip";
    requestHeaders.set("x-client-ip", "203.0.113.9");
    for (let i = 0; i < ADMIN_LIMIT.perClient; i += 1)
      expect((await exchange("wrong")).code).toBe("wrong_secret");
    // Limited: the right secret is not even compared, and no session is made.
    expect(await exchange(SECRET)).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    expect(requestCookies.size).toBe(0);
    // The exchange counts on the same counter as the gate always did.
    expect(checkAdminSecret(SECRET, "203.0.113.9")).toBe("limited");
    // Another client has its own count.
    requestHeaders.set("x-client-ip", "203.0.113.10");
    expect((await exchange(SECRET)).ok).toBe(true);

    // The window passes for the first client.
    vi.advanceTimersByTime(ADMIN_LIMIT.windowMs);
    requestHeaders.set("x-client-ip", "203.0.113.9");
    resetRequest();
    process.env.TRUSTED_PROXY_HEADER = "x-client-ip";
    requestHeaders.set("x-client-ip", "203.0.113.9");
    expect((await exchange(SECRET)).ok).toBe(true);

    // In total: 50 wrong ones from anywhere stop every client.
    resetAdminLimitForTests();
    for (let i = 0; i < ADMIN_LIMIT.total; i += 1) {
      requestHeaders.set("x-client-ip", `198.51.100.${i}`);
      expect((await exchange("wrong")).code).toBe("wrong_secret");
    }
    requestHeaders.set("x-client-ip", "203.0.113.77");
    expect((await exchange(SECRET)).code).toBe("rate_limited");
  });

  it("does not count right secrets or valid sessions against the lockout", async () => {
    process.env.TRUSTED_PROXY_HEADER = "x-client-ip";
    requestHeaders.set("x-client-ip", "203.0.113.9");
    for (let i = 0; i < ADMIN_LIMIT.total + 5; i += 1) {
      expect((await exchange(SECRET)).ok).toBe(true);
      expect((await list()).ok).toBe(true);
    }
    // Four wrong ones are still allowed after all that; the fifth locks.
    for (let i = 0; i < ADMIN_LIMIT.perClient; i += 1)
      expect(checkAdminSecret("wrong", "203.0.113.9")).toBe("wrong");
    expect(checkAdminSecret(SECRET, "203.0.113.9")).toBe("limited");
  });

  it("ends after an hour: the action says so and drops the cookie, without counting a wrong secret", async () => {
    await exchange(SECRET);
    vi.advanceTimersByTime(SECRET_SESSION_MS - 1000);
    expect((await list()).ok).toBe(true);
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < ADMIN_LIMIT.total + 1; i += 1) {
      signInWithSecret(Date.now() - SECRET_SESSION_MS);
      expect(await list()).toEqual({
        ok: false,
        message: "The admin-secret session has ended.",
        code: "session_expired",
        nextStep: "Sign in again (Account). The session lasts an hour.",
      });
      expect(requestCookies.has(ADMIN_SECRET_COOKIE)).toBe(false);
    }
    // None of those was a wrong guess: the secret still works.
    expect((await exchange(SECRET)).ok).toBe(true);
  });

  it("refuses a session whose time or signature was changed, and one of another secret, counting each as a wrong secret", async () => {
    const real = issueSecretSession()!.value;
    const [v, expires, mac] = real.split(".");
    process.env.ADMIN_SECRET = "another-secret-".repeat(3);
    const other = issueSecretSession()!.value;
    process.env.ADMIN_SECRET = SECRET;
    const forged = [
      // An hour more, with the old signature.
      `${v}.${Number(expires) + SECRET_SESSION_MS}.${mac}`,
      `${v}.${expires}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`,
      other,
      `v2.${expires}.${mac}`,
      SECRET,
      "x",
    ];
    expect(forged).toHaveLength(ADMIN_LIMIT.perClient + 1);
    for (const value of forged.slice(0, ADMIN_LIMIT.perClient))
      expect(checkSecretSession(value, "203.0.113.9")).toBe("wrong");
    // Five wrong sessions lock the client like five wrong secrets: the real session
    // and the real secret are not checked now.
    expect(checkSecretSession(real, "203.0.113.9")).toBe("limited");
    expect(checkAdminSecret(SECRET, "203.0.113.9")).toBe("limited");
    expect(checkSecretSession(forged[5], "203.0.113.10")).toBe("wrong");
    expect(checkSecretSession(real, "203.0.113.11")).toBe("ok");

    // Through an action: refused as signed out, and the cookie is dropped.
    requestCookies.set(ADMIN_SECRET_COOKIE, forged[0]);
    expect(await list()).toMatchObject({ ok: false, code: "signed_out" });
    expect(requestCookies.has(ADMIN_SECRET_COOKIE)).toBe(false);
  });

  it("ends every session when the secret changes or is removed", async () => {
    await exchange(SECRET);
    process.env.ADMIN_SECRET = "rotated-secret-".repeat(3);
    expect(await list()).toMatchObject({ ok: false, code: "signed_out" });
    signInWithSecret();
    expect((await list()).ok).toBe(true);
    process.env.ADMIN_SECRET = "";
    expect(await list()).toMatchObject({ ok: false, code: "admin_disabled" });
  });

  it("does not lift a read-only admin: the email sign-in decides", async () => {
    fakeAuth();
    accounts.admins.set(ANA.id, "viewer");
    await exchange(SECRET);
    requestCookies.set(ADMIN_COOKIE, `at-${ANA.id}`);
    expect(await list()).toMatchObject({ ok: false, code: "read_only" });
  });

  it("sign-out drops both cookies and ends the email session", async () => {
    const { signedOut } = fakeAuth();
    accounts.admins.set(ANA.id, "admin");
    await exchange(SECRET);
    await verifyAdminCodeAction({}, form({ email: ANA.email, code: "123456" }));
    expect(requestCookies.size).toBe(2);
    expect(await signOutAdminAction()).toEqual({
      ok: true,
      message: "Signed out.",
    });
    expect(requestCookies.size).toBe(0);
    expect(signedOut).toEqual([`at-${ANA.id}`]);
    expect(await list()).toMatchObject({ ok: false, code: "signed_out" });
  });
});
