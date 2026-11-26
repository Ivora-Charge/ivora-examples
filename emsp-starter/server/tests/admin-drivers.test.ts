import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Server actions read the request's cookies (the admin sessions); tests set them here.
vi.mock(
  "next/headers",
  async () => (await import("./support/request")).nextHeaders,
);

import {
  driverPageAction,
  listDriversAction,
} from "@/app/admin/drivers/actions";
import { DriverList } from "@/app/admin/drivers/driver-list";
import {
  AccountFacts,
  DriverPage,
  RecentPayments,
  RecentSessions,
} from "@/app/admin/drivers/[id]/driver-page";
import Page from "@/app/admin/drivers/[id]/page";
import { driverHref, referenceFromPath } from "@/app/admin/drivers/reference";
import { driverPaymentsAction } from "@/app/admin/payments/actions";
import { PaymentAdmin } from "@/app/admin/payments/payment-admin";
import PaymentsPage from "@/app/admin/payments/page";
import SessionsPage from "@/app/admin/sessions/page";
import { Sessions } from "@/app/admin/sessions/session-admin";
import { driverAccountAction } from "@/app/admin/tokens/actions";
import { AdminProvider, type Who } from "@/app/admin/ui/admin-context";
import { ADMIN_COOKIE } from "@/lib/accounts/admin-session";
import { clearUserCacheForTests } from "@/lib/accounts/api";
import type { AuthProvider } from "@/lib/accounts/auth";
import {
  setAccountStoreForTests,
  setAuthProviderForTests,
} from "@/lib/accounts/registry";
import { MemoryAccountStore } from "@/lib/accounts/store";
import { setDriverAppStoreForTests } from "@/lib/driver-app/registry";
import { MemoryDriverAppStore } from "@/lib/driver-app/store";
import { sampleSessions } from "@/lib/mock-cpo/sample-data";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { MemoryPeerStore } from "@/lib/ocpi/store";
import { setPaymentStoreForTests } from "@/lib/payments/registry";
import { MemoryPaymentStore } from "@/lib/payments/store";
import { resetAdminLimitForTests } from "@/lib/server/admin";
import { setSessionStoreForTests } from "@/lib/sessions/registry";
import { MemorySessionStore } from "@/lib/sessions/store";
import { blockToken, createAppToken } from "@/lib/tokens/manage";
import { setTokenStoreForTests } from "@/lib/tokens/registry";
import { MemoryTokenStore } from "@/lib/tokens/store";
import { LIVE_ENV } from "./support/network";
import {
  requestCookies,
  resetRequest,
  signInWithSecret,
} from "./support/request";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const SECRET = "s".repeat(32);
const saved = { ...process.env };
const PEER = "8b0f0b5e-3c47-4c1e-9d55-4f1f0f8d2b11";
const ADMIN_ID = "9c1c4c1e-8c47-4f5e-9d55-0f1f0f8d2b99";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ANA = id(1);
const BARE = "support/card #1?";

let peers: MemoryPeerStore;
let accounts: MemoryAccountStore;
let tokens: MemoryTokenStore;
let sessions: MemorySessionStore;
let payments: MemoryPaymentStore;
let driverApp: MemoryDriverAppStore;
let fetchSpy: ReturnType<typeof vi.fn>;

const form = (fields: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const list = (fields?: Record<string, string>) =>
  listDriversAction({}, form(fields));
const open = (driverRef: string) => driverPageAction({}, form({ driverRef }));

/** Signed in by email, with `role` in the admin table. */
function signInByEmail(role: "admin" | "viewer" = "admin") {
  resetRequest();
  setAuthProviderForTests({
    getUser: async () => ({ id: ADMIN_ID, email: "admin@example.com" }),
  } as unknown as AuthProvider);
  accounts.admins.set(ADMIN_ID, role);
  requestCookies.set(ADMIN_COOKIE, `token-${role}`);
}

/** Every audit entry about no subject: where email searches go. */
const searches = () =>
  peers.auditLog.filter((e) => e.action === "driver.search");

beforeEach(async () => {
  resetAdminLimitForTests();
  clearUserCacheForTests();
  for (const k of Object.keys(LIVE_ENV)) delete process.env[k];
  process.env.DEMO_MODE = "true";
  process.env.ADMIN_SECRET = SECRET;
  resetRequest();
  signInWithSecret();
  peers = new MemoryPeerStore();
  accounts = new MemoryAccountStore();
  tokens = new MemoryTokenStore();
  sessions = new MemorySessionStore();
  payments = new MemoryPaymentStore();
  driverApp = new MemoryDriverAppStore();
  setPeerStoreForTests(peers);
  setAccountStoreForTests(accounts);
  setTokenStoreForTests(tokens);
  setSessionStoreForTests(sessions);
  setPaymentStoreForTests(payments);
  setDriverAppStoreForTests(driverApp);
  fetchSpy = vi.fn(() => {
    throw new Error("no network in tests");
  });
  vi.stubGlobal("fetch", fetchSpy);

  await accounts.ensureDriver(ANA, "ana@example.com", "2026-10-01T00:00:00Z");
  await accounts.updateDriver(
    ANA,
    { defaultPaymentMethodId: "pm_secretCard" },
    "2026-10-01T00:00:00Z",
  );
  await accounts.setCustomer(ANA, "cus_secretCustomer", "2026-10-01T00:00:00Z");
  await accounts.recordSignIn(ANA, new Date().toISOString());
  await accounts.ensureDriver(id(2), "bob@example.org", "2026-10-02T00:00:00Z");
});

afterEach(() => {
  setPeerStoreForTests(undefined);
  setAccountStoreForTests(undefined);
  setAuthProviderForTests(undefined);
  setTokenStoreForTests(undefined);
  setSessionStoreForTests(undefined);
  setPaymentStoreForTests(undefined);
  setDriverAppStoreForTests(undefined);
  resetRequest();
  vi.unstubAllGlobals();
  process.env = { ...saved };
  expect(fetchSpy).not.toHaveBeenCalled();
});

const report = (driverRef: string) =>
  driverApp.addReport(
    {
      driverRef,
      locationId: "loc",
      evseUid: null,
      category: "other",
      message: "Broken",
      photoType: null,
      photoBase64: null,
    },
    new Date().toISOString(),
  );

describe("the driver list", () => {
  it("is for an admin: nobody else, and no read-only viewer", async () => {
    resetRequest();
    for (const action of [
      listDriversAction,
      driverPageAction,
      driverPaymentsAction,
    ]) {
      const r = await action({}, form({ driverRef: ANA }));
      expect(r).toMatchObject({ ok: false, code: "signed_out" });
      expect(JSON.stringify(r)).not.toContain("@example");
    }
    signInByEmail("viewer");
    for (const action of [
      listDriversAction,
      driverPageAction,
      driverPaymentsAction,
    ]) {
      const r = await action({}, form({ driverRef: ANA }));
      expect(r).toMatchObject({ ok: false, code: "read_only" });
      expect(JSON.stringify(r)).not.toContain("@example");
    }
  });

  it("shows an admin signed in by email every fact, newest first, never card data", async () => {
    signInByEmail();
    const dep = { tokens, peers, actor: "test" };
    const { token } = await createAppToken({ driverRef: ANA }, dep);
    await blockToken(token.uid, "APP_USER", dep);
    await report(ANA);
    await report(ANA);
    const resolved = await report(ANA);
    await driverApp.resolveReport(resolved.id, "a", new Date().toISOString());

    const r = await list();
    expect(r).toMatchObject({
      ok: true,
      message: "2 account(s).",
      filtered: false,
      counts: {
        total: 2,
        blocked: 0,
        withCard: 1,
        signedInSince: 1,
        matching: 2,
      },
    });
    expect(r.next).toBeUndefined();
    expect(r.drivers!.map((d) => d.email)).toEqual([
      "bob@example.org",
      "ana@example.com",
    ]);
    expect(r.drivers![1]).toEqual({
      id: ANA,
      email: "ana@example.com",
      status: "active",
      hasCard: true,
      createdAt: "2026-10-01T00:00:00Z",
      lastSignInAt: expect.any(String),
      appToken: "blocked",
      openProblems: 2,
    });
    expect(r.drivers![0]).toMatchObject({
      hasCard: false,
      lastSignInAt: null,
      appToken: "none",
      openProblems: 0,
    });
    expect(JSON.stringify(r)).not.toMatch(/pm_|cus_|secret/);
    // A list that searched for no email is not a search to audit.
    expect(searches()).toEqual([]);
  });

  it("counts only those who signed in within 30 days", async () => {
    await accounts.recordSignIn(
      id(2),
      new Date(Date.now() - 31 * 86_400_000).toISOString(),
    );
    expect((await list()).counts!.signedInSince).toBe(1);
  });

  it("sends an admin-secret session no email, in the list, a page or a block", async () => {
    const answers = [
      await list(),
      await list({ reference: ANA }),
      await open(ANA),
      await driverAccountAction({}, form({ driverRef: ANA, intent: "show" })),
      await driverAccountAction({}, form({ driverRef: ANA, intent: "block" })),
    ];
    for (const r of answers) {
      expect(r.ok).toBe(true);
      expect(JSON.stringify(r)).not.toMatch(/@|example\.(com|org)/);
    }
    expect(answers[0]).toMatchObject({
      drivers: [{ email: null }, { email: null }],
    });
    expect(answers[2]).toMatchObject({
      account: { id: ANA, email: null, status: "active" },
    });
  });

  it("refuses an admin-secret session an email search, reading nothing", async () => {
    const listed = vi.spyOn(accounts, "listDrivers");
    const counted = vi.spyOn(accounts, "countDrivers");
    const r = await list({ email: "ana" });
    expect(r).toMatchObject({
      ok: false,
      code: "email_search_refused",
      message: "Search by email needs an admin signed in by email.",
    });
    expect(r.nextStep).toBeTruthy();
    expect(r.drivers).toBeUndefined();
    expect(r.counts).toBeUndefined();
    expect(listed).not.toHaveBeenCalled();
    expect(counted).not.toHaveBeenCalled();
  });

  it("searches by email and audits who, how and how many, never what", async () => {
    signInByEmail();
    const r = await list({ email: "  ANA@Example " });
    expect(r).toMatchObject({
      ok: true,
      filtered: true,
      message: "1 of 2 account(s) match.",
      counts: { total: 2, matching: 1 },
      drivers: [{ id: ANA, email: "ana@example.com" }],
    });
    await list({ email: "nobody-here" });
    expect(searches()).toEqual([
      {
        actor: `admin:${ADMIN_ID}`,
        action: "driver.search",
        details: { by: "email", rows: 1 },
        at: expect.any(String),
      },
      {
        actor: `admin:${ADMIN_ID}`,
        action: "driver.search",
        details: { by: "email", rows: 0 },
        at: expect.any(String),
      },
    ]);
    expect(JSON.stringify(peers.auditLog)).not.toMatch(
      /ana@|ANA@|nobody-here|example/i,
    );
  });

  it("shows nothing when the search cannot be audited, and logs no email", async () => {
    signInByEmail();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(peers, "audit").mockRejectedValue(new Error("ana@example.com"));
    const r = await list({ email: "ana" });
    expect(r).toMatchObject({
      ok: false,
      message: "Could not read the drivers. Try again.",
    });
    expect(r.drivers).toBeUndefined();
    expect(r.counts).toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toContain("ana");
    log.mockRestore();
  });

  it("finds an exact reference for either kind of admin, without an audit entry", async () => {
    expect(await list({ reference: ` ${ANA} ` })).toMatchObject({
      ok: true,
      reference: ANA,
      filtered: true,
      drivers: [{ id: ANA }],
      message: "1 of 2 account(s) match.",
    });
    expect(await list({ reference: ANA.slice(0, 30) })).toMatchObject({
      ok: true,
      drivers: [],
      counts: { matching: 0 },
    });
    expect(searches()).toEqual([]);
  });

  it("pages by a cursor, auditing each page of an email search", async () => {
    signInByEmail();
    for (let n = 3; n <= 60; n++)
      await accounts.ensureDriver(
        id(n),
        `d${n}@example.com`,
        "2026-10-03T00:00:00.000Z",
      );
    const seen: string[] = [];
    let older = "";
    let pages = 0;
    do {
      const r = await list({ email: "@example.com", older });
      expect(r.ok).toBe(true);
      expect(r.counts).toMatchObject({ total: 60, matching: 59 });
      seen.push(...r.drivers!.map((d) => d.id));
      older = r.next ?? "";
      pages++;
    } while (older && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(59);
    expect(seen).toHaveLength(59);
    expect(seen.at(-1)).toBe(ANA);
    expect(searches().map((e) => e.details!.rows)).toEqual([25, 25, 9]);
  });

  it("refuses a malformed cursor, email or reference", async () => {
    signInByEmail();
    const listed = vi.spyOn(accounts, "listDrivers");
    for (const bad of [
      { older: "yesterday" },
      { older: `2026-10-01T00:00:00Z|${ANA}|x` },
      { older: `2026-10-01",id.neq."|${ANA}` },
      { email: "a*" },
      { email: "a b" },
      { reference: "two words" },
      { reference: "x".repeat(65) },
    ] as Record<string, string>[])
      expect(await list(bad), JSON.stringify(bad)).toMatchObject({
        ok: false,
      });
    expect(listed).not.toHaveBeenCalled();
    expect(searches()).toEqual([]);
  });

  it("says the problem counts are at least when not every report was read", async () => {
    for (let n = 0; n < 1000; n++) await report(ANA);
    const r = await list();
    expect(r.problemsCapped).toBe(true);
    expect(r.drivers![1].openProblems).toBe(1000);
  });
});

describe("a driver's page", () => {
  /** `n` sessions of `driverRef`, one a minute, oldest first. */
  async function charge(driverRef: string, n: number) {
    const [sample] = sampleSessions(
      { countryCode: "ZZ", partyId: "MCK" },
      { countryCode: "NL", partyId: "DMO" },
    );
    for (let i = 0; i < n; i++) {
      await sessions.insertSession(
        PEER,
        {
          session: {
            ...sample,
            id: `${driverRef}-${i}`,
            start_date_time: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
          },
          fieldTimes: {},
          driverRef,
          commandId: null,
          completedAt: null,
        },
        "2026-10-01T00:00:00.000Z",
      );
      await payments.insert(
        {
          commandId: `${driverRef}-command-${i}`,
          driverRef,
          currency: "EUR",
          holdAmount: 2500,
          paymentMethodId: "pm_secretCard",
        },
        new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
      );
    }
  }

  it("has the account, and the last 10 sessions and payments of this driver only", async () => {
    await charge(ANA, 12);
    await charge(id(2), 2);
    await report(ANA);
    const r = await open(ANA);
    expect(r).toMatchObject({
      ok: true,
      message: "Driver found.",
      account: { id: ANA, hasCard: true, openProblems: 1 },
      openProblems: 1,
    });
    expect(r.sessions).toHaveLength(10);
    expect(r.sessions!.every((s) => s.driverRef === ANA)).toBe(true);
    expect(r.sessions![0].ref).toContain(`${ANA}-11`);
    expect(r.payments).toHaveLength(10);
    expect(r.payments![0]).toEqual({
      id: expect.any(String),
      status: "pending",
      currency: "EUR",
      holdAmount: 2500,
      capturedAmount: 0,
      refundedAmount: 0,
      review: null,
      reviewedAt: null,
      createdAt: "2026-10-01T00:11:00.000Z",
    });
    expect(JSON.stringify(r)).not.toMatch(/pm_|cus_|pi_/);
  });

  it("opens for a bare reference with no account yet", async () => {
    await charge(BARE.replaceAll(" ", "-"), 1);
    const ref = BARE.replaceAll(" ", "-");
    await report(ref);
    expect(await open(ref)).toMatchObject({
      ok: true,
      message: "No account yet.",
      account: null,
      openProblems: 1,
      sessions: [{ driverRef: ref }],
      payments: [{ status: "pending" }],
    });
    expect(
      await driverAccountAction({}, form({ driverRef: ref, intent: "block" })),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(peers.auditLog).toEqual([]);
    expect(await open("two words")).toMatchObject({ ok: false });
  });

  it("blocks and unblocks through the audited action, as the email admin", async () => {
    signInByEmail();
    expect(
      await driverAccountAction({}, form({ driverRef: ANA, intent: "block" })),
    ).toMatchObject({
      ok: true,
      driver: { email: "ana@example.com", status: "restricted" },
    });
    expect((await open(ANA)).account!.status).toBe("restricted");
    expect((await list()).counts!.blocked).toBe(1);
    expect(await peers.listAudit(ANA, 5)).toMatchObject([
      { actor: `admin:${ADMIN_ID}`, action: "driver.block" },
    ]);
  });

  it("lists a driver's payments on Payments, by the exact reference", async () => {
    await charge(ANA, 3);
    await charge(id(2), 1);
    const r = await driverPaymentsAction({}, form({ driverRef: ANA }));
    expect(r.message).toBe("3 payment(s).");
    expect(r.payments!.map((p) => p.driverRef)).toEqual([ANA, ANA, ANA]);
    expect(JSON.stringify(r)).not.toMatch(/pm_|pi_/);
    expect(
      await driverPaymentsAction({}, form({ driverRef: "nobody" })),
    ).toMatchObject({ ok: true, message: "No payments for this driver." });
    expect(
      await driverPaymentsAction({}, form({ driverRef: "" })),
    ).toMatchObject({ ok: false });
  });
});

const render = (admin: Who, children: ReactElement) =>
  renderToStaticMarkup(
    createElement(AdminProvider, {
      admin,
      secret: admin === null,
      demo: false,
      children,
    }),
  );
const ana: Who = { email: "admin@example.com", role: "admin" };

describe("pages and links", () => {
  it("puts any reference in a driver's address and reads it back", async () => {
    for (const ref of [ANA, "demo-driver", "a/b?c#d", "100%", "x+y&z=1"]) {
      const href = driverHref(ref);
      const segment = href.slice("/admin/drivers/".length);
      expect(segment).not.toMatch(/[/?#]/);
      expect(referenceFromPath(segment)).toBe(ref);
    }
    for (const bad of ["%", "%zz", "two%20words", "x".repeat(65), ""])
      expect(referenceFromPath(bad)).toBeNull();
    await expect(
      Page({ params: Promise.resolve({ id: "two%20words" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("offers the email search to an admin signed in by email only, never in the address", () => {
    const list = createElement(DriverList, { sampleDriver: null });
    const byEmail = render(ana, list);
    expect(byEmail).toContain('name="email"');
    expect(byEmail).toContain('name="reference"');
    // Sent before the page is ready, a form must not put the address in the URL.
    expect(byEmail).toMatch(/<form[^>]*method="post"/);
    const secret = render(null, list);
    expect(secret).not.toContain('name="email"');
    expect(secret).toContain('name="reference"');
    expect(secret).toContain("only for an admin signed in by");
  });

  it("shows nobody signed in a prompt and no data", () => {
    for (const part of [
      createElement(DriverList, { sampleDriver: "demo-driver" }),
      createElement(DriverPage, { driverRef: ANA }),
    ]) {
      const html = renderToStaticMarkup(
        createElement(AdminProvider, {
          admin: null,
          demo: false,
          children: part,
        }),
      );
      expect(html).toContain("Sign in as an admin to see");
      expect(html).not.toContain("<form");
      expect(html).not.toContain("demo-driver");
    }
  });

  it("links a driver's sessions and payments to their pages, filtered", async () => {
    const ref = "a&b";
    const s = render(
      ana,
      createElement(RecentSessions, {
        driverRef: ref,
        sessions: [
          {
            id: "s",
            peer: "CPO",
            ref: "ZZ/MCK/S-1",
            status: "ACTIVE",
            start: "2026-10-01T00:00:00Z",
            end: null,
            kwh: 1,
            cost: null,
            location: "LOC",
            authMethod: "COMMAND",
            driverRef: ref,
            commandId: null,
            stopReason: null,
          },
        ],
      }),
    );
    expect(s).toContain('href="/admin/sessions?driver=a%26b&amp;search=S-1"');
    expect(s).toContain('href="/admin/sessions?driver=a%26b"');
    const p = render(
      ana,
      createElement(RecentPayments, {
        driverRef: ref,
        payments: [
          {
            id: id(7),
            status: "captured",
            currency: "EUR",
            holdAmount: 2500,
            capturedAmount: 1234,
            refundedAmount: 0,
            review: null,
            reviewedAt: null,
            createdAt: "2026-10-01T00:00:00Z",
          },
        ],
      }),
    );
    expect(p).toContain(`href="/admin/payments?find=${id(7)}"`);
    expect(p).toContain('href="/admin/payments?driver=a%26b"');
    expect(p).toContain("12.34");
  });

  it("says who sees an email on the driver's facts", () => {
    const html = render(
      null,
      createElement(AccountFacts, {
        d: {
          id: ANA,
          email: null,
          status: "restricted",
          hasCard: false,
          createdAt: "2026-10-01T00:00:00Z",
          lastSignInAt: null,
          appToken: "expired",
          openProblems: 0,
        },
      }),
    );
    expect(html).toContain("shown only to an admin signed in by email");
    expect(html).toContain("not recorded");
    expect(html).toContain("Blocked");
    expect(html).toContain("Expired");
  });

  it("fills in Sessions from its address, and ignores a malformed one", async () => {
    const filled = await SessionsPage({
      searchParams: Promise.resolve({ driver: ANA, search: "S-1" }),
    });
    expect(filled.props.prefill).toEqual({ driverRef: ANA, search: "S-1" });
    const html = render(ana, createElement(Sessions, filled.props));
    expect(html).toContain(`value="${ANA}"`);
    expect(html).toContain('value="S-1"');
    expect(html).toMatch(/<details class="fold" open="">/);
    const none = await SessionsPage({
      searchParams: Promise.resolve({ driver: ["a", "b"], search: "a*b" }),
    });
    expect(none.props.prefill).toEqual({ driverRef: "", search: "" });
    expect(render(ana, createElement(Sessions, none.props))).not.toContain(
      '<details class="fold" open',
    );
  });

  it("fills in Payments from its address, the driver's payments first", async () => {
    const page = JSON.stringify(
      await PaymentsPage({
        searchParams: Promise.resolve({ driver: ANA }),
      }),
    );
    expect(page).toContain(`"driver":"${ANA}"`);
    const html = render(
      ana,
      createElement(PaymentAdmin, {
        demo: false,
        stripeSet: true,
        driver: ANA,
      }),
    );
    expect(html).toContain(`value="${ANA}"`);
    expect(html.indexOf("A driver&#x27;s payments")).toBeLessThan(
      html.indexOf("To review"),
    );
  });
});
