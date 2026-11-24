import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaymentSummary } from "@/app/admin/payments/actions";
import { PaymentPanel } from "@/app/admin/payments/payment-admin";
import {
  refundRequestId,
  spendRefundRequestId,
} from "@/app/admin/payments/request-id";
import type { ActionState, PeerSummary } from "@/app/admin/peers/actions";
import { Refused } from "@/app/admin/peers/connect/connect";
import { HubParties } from "@/app/admin/peers/[id]/peer-page";
import { moduleName, viewOf } from "@/app/admin/peers/peer-view";
import { tokenRefused } from "@/app/admin/peers/refused";
import { FindReport } from "@/app/admin/problems/problem-admin";
import {
  firstAdminSql,
  LIMITED_MESSAGE,
  signInProblem,
} from "@/app/admin/sign-in/states";
import { TokenByUid } from "@/app/admin/tokens/token-admin";
import { AdminProvider, type Who } from "@/app/admin/ui/admin-context";
import { oneAtATime } from "@/app/admin/ui/use-action";
import SetupPage from "@/app/page";
import { firstAdmin, Setup, type SetupFacts } from "@/app/setup";
import { AuthRateLimitedError, type AuthProvider } from "@/lib/accounts/auth";
import {
  requestCode,
  resetSignInLimitsForTests,
  SIGN_IN_LIMITS,
  SignInError,
} from "@/lib/accounts/sign-in";
import type { AdminIdentity } from "@/lib/accounts/admin-session";
import { explainMessage } from "@/lib/admin/errors";
import {
  configErrors,
  LIVE_REQUIRED,
  missingForLive,
} from "@/lib/server/config";

// Who the server finds signed in by email: nobody, unless a test says otherwise.
const signedInAdmin = vi.hoisted(() => ({
  current: null as AdminIdentity | null,
}));
vi.mock("@/app/admin/ui/current-admin", () => ({
  requestAdmin: async () => signedInAdmin.current,
}));

/**
 * The admin pages add no server behaviour: they read today's answers. These tests hold
 * the pages to those answers, so a change of a server sentence or code shows up here.
 */
const peer = (over: Partial<PeerSummary> = {}): PeerSummary => ({
  id: "11111111-1111-4111-8111-111111111111",
  label: "Example Roaming Hub",
  direction: "outbound",
  status: "registered",
  versionsUrl: "https://hub.example.net/ocpi/versions",
  parties: ["HUB NL-ERH (Example Roaming Hub)"],
  modules: ["locations", "tariffs"],
  registeredAt: "2026-11-24T14:07:00.000Z",
  ...over,
});

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : /\.tsx?$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );

describe("sign-in page: what today's answers mean", () => {
  afterEach(() => resetSignInLimitsForTests());

  it("reads both rate limits as 'wait and try again'", async () => {
    // The email service's limit and this server's end as the same sentence today.
    expect(signInProblem(new AuthRateLimitedError().message)).toBe("limited");
    resetSignInLimitsForTests();
    const auth = { sendCode: async () => {} } as unknown as AuthProvider;
    let refused: unknown;
    for (let i = 0; i <= SIGN_IN_LIMITS.code.perEmail.limit; i += 1)
      await requestCode({ email: "ana@example.com" }, null, { auth }).catch(
        (e) => (refused = e),
      );
    expect(refused).toBeInstanceOf(SignInError);
    expect((refused as SignInError).message).toBe(LIMITED_MESSAGE);
    expect(signInProblem((refused as SignInError).message)).toBe("limited");
  });

  it("reads the admin-list refusal, and nothing else, as 'not an admin'", () => {
    expect(
      readFileSync(join(__dirname, "../app/admin/sign-in/actions.ts"), "utf8"),
    ).toContain('message: "This account is not an admin."');
    expect(signInProblem("This account is not an admin.")).toBe("not_admin");
    expect(signInProblem("Wrong or expired code. Ask for a new one.")).toBe(
      "other",
    );
    expect(signInProblem(undefined)).toBe("other");
  });

  it("writes the first admin's statement for the address used, safely quoted", () => {
    expect(firstAdminSql("ana@example.com")).toBe(
      "insert into public.emsp_admins (user_id, role)\nselect id, 'admin' from auth.users\nwhere email = 'ana@example.com';",
    );
    expect(firstAdminSql("o'neil@example.com")).toContain(
      "where email = 'o''neil@example.com';",
    );
  });
});

describe("admin secret: asked once, kept in page memory only", () => {
  const app = files(join(__dirname, "../app")).map(
    (f) => [f, readFileSync(f, "utf8")] as const,
  );

  it("no page has a field for it except the sign-in page", () => {
    const withField = app
      .filter(([, src]) => /name="adminSecret"|Admin secret<\/label>/.test(src))
      .map(([f]) => f.split("/app/")[1]);
    expect(withField).toEqual(["admin/sign-in/sign-in-form.tsx"]);
  });

  it("no page uses browser storage or sets a cookie from script", () => {
    for (const [f, src] of app)
      expect(src, f).not.toMatch(
        /(localStorage|sessionStorage|indexedDB)\s*[.[]|document\.cookie\s*=/,
      );
  });
});

describe("connect flow: a refused one-time token", () => {
  const refusedAnswer: ActionState = {
    ok: false,
    message:
      "Registration at the CPO failed: POST hub.example.net/ocpi/2.2.1/credentials refused our token (HTTP 401)",
    ...explainMessage("refused our token (HTTP 401)"),
  };

  it("is recognised from today's code and message", () => {
    expect(refusedAnswer.code).toBe("HTTP 401");
    // The general next step is written for a registered peer.
    expect(refusedAnswer.nextStep).toMatch(/Rotate tokens/);
    expect(tokenRefused(refusedAnswer)).toBe(true);
    expect(tokenRefused({ ok: false, code: "HTTP 403" })).toBe(true);
    // The peer gave an OCPI status too: the code is that, the message still says 401.
    expect(
      tokenRefused({
        ok: false,
        code: "OCPI 2000",
        message: "x refused our token (HTTP 401): bad token",
      }),
    ).toBe(true);
    expect(
      tokenRefused({ ok: false, code: "demo_mode", message: "Demo mode: no" }),
    ).toBe(false);
    expect(tokenRefused({ ok: false, code: "HTTP 500" })).toBe(false);
    expect(tokenRefused({ ok: true })).toBe(false);
  });

  it("says 'get a new one-time token', not 'rotate tokens', and gives both next steps", () => {
    const html = renderToStaticMarkup(
      createElement(Refused, { state: refusedAnswer, given: "hub" }),
    );
    expect(html).toContain("The hub refused the one-time token.");
    expect(html).toContain("HTTP 401");
    expect(html).toContain(
      "Get a new one-time token in the hub&#x27;s portal and paste it below.",
    );
    expect(html).toContain("Rotating tokens does not help here");
    // Today's answer cannot tell a first registration from a registered peer.
    expect(html).toContain("already shows as Registered");
    expect(html).toContain("rotate its tokens instead");
    expect(html).toContain("may spend the token, even if it failed later");
    expect(html).not.toContain("Rotate tokens (CPO peers)");
  });
});

describe("peers: a row and a hub's page, from the peer list", () => {
  const hub = peer({
    hub: {
      parties: [
        {
          countryCode: "DE",
          partyId: "RVE",
          status: "trusted",
          source: "admin",
          name: "Riverside EV",
        },
        {
          countryCode: "NL",
          partyId: "LVP",
          status: "offered",
          source: "hubclientinfo",
          name: "Lakeview Power",
        },
        {
          countryCode: "BE",
          partyId: "MSQ",
          status: "offered",
          source: "credentials",
        },
      ],
    },
  });

  it("words a peer's state", () => {
    expect(viewOf(hub)).toMatchObject({
      tag: "Hub",
      state: { kind: "ok", text: "Registered" },
      trusted: 1,
      offered: 2,
    });
    expect(
      viewOf(peer({ status: "pending", direction: "inbound", parties: [] })),
    ).toMatchObject({
      tag: "Peer",
      state: { kind: "todo", text: "Waiting for them to register" },
    });
    const failing = viewOf(
      peer({
        parties: ["CPO NL-HSC (Harbour Street Charge)"],
        sync: [
          {
            module: "sessions@NL-HSC",
            lastPullAt: "2026-11-24T14:01:00.000Z",
            lastFullSyncAt: null,
            ok: false,
            items: 0,
            invalid: 0,
            running: false,
            error: "failed with OCPI status 3000",
            code: "OCPI 3000",
            nextStep: "Try again later.",
          },
        ],
      }),
    );
    expect(failing.tag).toBe("CPO");
    expect(failing.state).toEqual({
      kind: "bad",
      text: "Sessions of NL-HSC pull failing",
    });
    expect(moduleName("cdrs")).toBe("CDRs");
  });

  it("lists trusted and offered parties with Accept and Remove on each row", () => {
    const html = renderToStaticMarkup(
      createElement(HubParties, { peer: hub, send: async () => ({}) }),
    );
    expect(html).toMatch(/Trusted <span class="muted">1<\/span>/);
    expect(html).toMatch(/Offered <span class="muted">2<\/span>/);
    expect(html).toContain('Remove<span class="sr"> Riverside EV</span>');
    expect(html).toContain('Accept<span class="sr"> Lakeview Power</span>');
    expect(html).toContain('Accept<span class="sr"> BE-MSQ</span>');
    expect(html).toContain("Not trusted: nothing is sent or accepted.");
    expect(html).toContain("Read the hub&#x27;s list again");
    expect(html).toContain("Add a party the hub does not list");
    expect(html).toContain(
      "Check your subscription in the hub&#x27;s own portal",
    );
    // No field asks for the hub's peer ID: the page knows which hub it is.
    expect(html).not.toMatch(/peer ID/i);
  });

  it("says a hub is idle until a party is trusted", () => {
    const html = renderToStaticMarkup(
      createElement(HubParties, {
        peer: peer({ hub: { parties: [] } }),
        send: async () => ({}),
      }),
    );
    expect(html).toContain("Connected, but idle: no party is trusted yet.");
    expect(html).toContain("Accept the CPOs you have an agreement with.");
  });
});

/** A page part as the server first renders it, for `admin` (null: nobody signed in). */
const page = (admin: Who, part: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(
    createElement(AdminProvider, {
      admin,
      demo: false,
      children: part,
    }),
  );
const ana: Who = { email: "ana@example.com", role: "admin" };

describe("payments: one payment's panel", () => {
  const payment = (over: Partial<PaymentSummary> = {}): PaymentSummary => ({
    id: "22222222-2222-4222-8222-222222222222",
    commandId: "cmd-1",
    driverRef: "driver-1",
    status: "held",
    currency: "EUR",
    holdAmount: 2500,
    authorizedAmount: 2500,
    capturedAmount: 0,
    refundedAmount: 0,
    cdrAmount: null,
    cdrCurrency: null,
    review: null,
    shortfallAmount: 0,
    reviewedAt: null,
    stopReason: null,
    error: "",
    createdAt: "2026-11-24T14:07:00.000Z",
    ...over,
  });

  it("offers capture and release for any held payment, not only one under review", () => {
    // The server captures or releases any held payment (lib/payments/settle.ts).
    const held = page(ana, createElement(PaymentPanel, { payment: payment() }));
    expect(held).toContain("Decide this payment");
    expect(held).toContain("Capture amount");
    expect(held).toContain("Release hold");
    const flagged = page(
      ana,
      createElement(PaymentPanel, {
        payment: payment({ status: "captured", review: "dispute" }),
      }),
    );
    expect(flagged).toContain("Mark reviewed");
    const settled = page(
      ana,
      createElement(PaymentPanel, {
        payment: payment({ status: "captured", capturedAmount: 900 }),
      }),
    );
    expect(settled).not.toContain("Decide this payment");
    expect(settled).toContain("Refund");
  });

  it("keeps a refund's request ID per payment until its outcome is known", () => {
    const a = "33333333-3333-4333-8333-333333333333";
    const b = "44444444-4444-4444-8444-444444444444";
    const first = refundRequestId(a);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    // The panel is closed and opened again, or the payment found again: same ID.
    expect(refundRequestId(a)).toBe(first);
    expect(refundRequestId(b)).not.toBe(first);
    // The form a reopened panel renders sends that kept ID.
    const html = page(
      ana,
      createElement(PaymentPanel, { payment: payment({ id: a }) }),
    );
    expect(html).toContain(`name="requestId" value="${first}"`);
    // Once the outcome is known the next refund of that payment gets a new one.
    const next = spendRefundRequestId(a);
    expect(next).not.toBe(first);
    expect(refundRequestId(a)).toBe(next);
    expect(
      page(ana, createElement(PaymentPanel, { payment: payment({ id: a }) })),
    ).toContain(`name="requestId" value="${next}"`);
  });
});

describe("lookups that need no listed row", () => {
  it("changes a token by its UID and type, without the driver reference", () => {
    const html = page(ana, createElement(TokenByUid));
    expect(html).toContain('name="uid"');
    expect(html).toContain('name="type"');
    expect(html).toContain('name="whitelist"');
    expect(html).not.toContain('name="driverRef"');
    for (const intent of ["block", "unblock", "whitelist"])
      expect(html).toContain(`value="${intent}" name="intent"`);
  });

  it("finds a problem report by its ID", () => {
    const html = page(
      ana,
      createElement(FindReport, { onResolved: async () => {} }),
    );
    expect(html).toContain('name="reportId"');
    expect(html).toContain("Find report");
  });
});

describe("peer page: one action at a time", () => {
  it("ignores a second press while the first is still on its way", async () => {
    let sent = 0;
    let finish: (value: string) => void = () => {};
    const rotate = oneAtATime(
      () =>
        new Promise<string>((resolve) => {
          sent += 1;
          finish = resolve;
        }),
      "skipped",
    );
    const first = rotate();
    await expect(rotate()).resolves.toBe("skipped");
    await expect(rotate()).resolves.toBe("skipped");
    expect(sent).toBe(1);
    finish("rotated");
    await expect(first).resolves.toBe("rotated");
    // Once it has answered, the next press is sent.
    const again = rotate();
    expect(sent).toBe(2);
    finish("rotated again");
    await expect(again).resolves.toBe("rotated again");
  });

  it("lets the next press through after a failure", async () => {
    let fail = true;
    const pull = oneAtATime(async () => {
      if (fail) throw new Error("no answer");
      return "pulled";
    }, "skipped");
    await expect(pull()).rejects.toThrow("no answer");
    fail = false;
    await expect(pull()).resolves.toBe("pulled");
  });
});

describe("setup: nothing for a visitor who is not signed in", () => {
  const read = {
    missing: [] as string[],
    errors: [] as string[],
    malformed: 0,
    baseUrl: "https://emsp.example.com",
    stripeKey: false,
    webhookSecret: false,
    cronSecret: false,
    holds: ["€25.00"],
  };
  const facts = (
    settings: SetupFacts["settings"],
    demo = false,
  ): SetupFacts => ({
    demo,
    required: 6,
    version: "2.2.1",
    party: "NL-EXA",
    codesPerHour: 5,
    settings,
  });

  // A deployment with unset live-mode settings and malformed optional ones.
  const MALFORMED = {
    STRIPE_SECRET_KEY: "bad",
    STRIPE_WEBHOOK_SECRET: "bad",
    HOLD_AMOUNTS: "bad",
    RESEND_API_KEY: "bad",
    ADMIN_SECRET: "e2e-only-admin-secret-0123456789abcdef",
  };
  const saved = { ...process.env };
  afterEach(() => {
    signedInAdmin.current = null;
    process.env = { ...saved };
  });

  it("the server sends a visitor no setting's name, no config error and no secret flag", async () => {
    for (const name of LIVE_REQUIRED) delete process.env[name];
    Object.assign(process.env, MALFORMED);
    // The deployment does have something to say, to an admin.
    expect(missingForLive().length).toBeGreaterThan(0);
    const errors = configErrors();
    for (const name of [
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "HOLD_AMOUNTS",
      "RESEND_API_KEY",
    ])
      expect(errors.some((e) => e.startsWith(`${name} `))).toBe(true);

    // Nobody is signed in: everything the page hands to the browser (its RSC data).
    const element = await SetupPage();
    const sent = (element.props as { facts: SetupFacts }).facts;
    expect(sent.settings).toBeNull();
    expect(Object.keys(sent).sort()).toEqual([
      "codesPerHour",
      "demo",
      "party",
      "required",
      "settings",
      "version",
    ]);
    const data = JSON.stringify(element.props);
    // No environment variable's name, whatever it is called.
    expect(data).not.toMatch(/[A-Z][A-Z0-9]+_[A-Z0-9_]+/);
    for (const e of errors) expect(data).not.toContain(e);
    expect(data).not.toMatch(
      /must |missing|errors|malformed|stripe|webhook|cron|hold|secret/i,
    );
    // And the page as rendered for them.
    const html = page(null, element);
    expect(html).toContain("Sign in as an admin to see this deployment");
    expect(html).not.toMatch(/[A-Z][A-Z0-9]+_[A-Z0-9_]+/);
    expect(html).not.toMatch(/must |is not set|Malformed|Missing|secret/i);
  });

  it("the server reads the settings for an admin signed in by email", async () => {
    for (const name of LIVE_REQUIRED) delete process.env[name];
    Object.assign(process.env, MALFORMED);
    signedInAdmin.current = { userId: "u1", ...ana! };
    const element = await SetupPage();
    const sent = (element.props as { facts: SetupFacts }).facts;
    expect(sent.settings?.missing).toEqual([...LIVE_REQUIRED]);
    expect(sent.settings?.errors.join(" ")).toContain("STRIPE_SECRET_KEY");
    expect(sent.settings?.stripeKey).toBe(false);
    const html = page(ana, element);
    expect(html).toContain("<code>PUBLIC_BASE_URL</code> is not set");
    expect(html).toContain("<code>HOLD_AMOUNTS</code>");
    // Names only: no value reaches the page.
    expect(JSON.stringify(element.props)).not.toContain(MALFORMED.ADMIN_SECRET);
  });

  it("no page's shared data says whether the admin secret is set", () => {
    // Only the sign-in page is told (it offers the secret); the layout is not.
    const layout = readFileSync(join(__dirname, "../app/layout.tsx"), "utf8");
    expect(layout).not.toMatch(/adminEnabled|secretEnabled|ADMIN_SECRET/);
    const users = files(join(__dirname, "../app")).filter((f) =>
      /secretEnabled|adminEnabled\(/.test(readFileSync(f, "utf8")),
    );
    expect(users.map((f) => f.split("/app/")[1]).sort()).toEqual([
      "admin/sign-in/page.tsx",
      "admin/sign-in/sign-in-form.tsx",
    ]);
  });

  it("shows the sign-in prompt only, even if the page were given the settings", () => {
    const html = page(null, createElement(Setup, { facts: facts(read) }));
    expect(html).toContain("Sign in as an admin to see this deployment");
    expect(html).toContain('href="/admin/sign-in"');
    expect(html).not.toMatch(/STRIPE|CRON_SECRET|Setup checklist|NL-EXA/);
    expect(html).not.toMatch(/<input|<ol/);
  });

  it("shows a signed-in admin the stops, with the unset settings by name", () => {
    const html = page(ana, createElement(Setup, { facts: facts(read) }));
    expect(html).toContain("Setup checklist");
    expect(html).toContain("Environment complete");
    expect(html).toContain("<code>STRIPE_SECRET_KEY</code>");
    expect(html).toContain("<code>CRON_SECRET</code> is not set");
  });

  it("says 'cannot check from here' where the settings were not read", () => {
    // An admin-secret sign-in: the server did not see it when it rendered.
    const html = page(ana, createElement(Setup, { facts: facts(null) }));
    expect(html).not.toContain("is not set, so the job never runs");
    expect(html).not.toContain("Payments are not set up");
    expect(html.match(/Cannot check from here/g)?.length).toBeGreaterThan(2);
    // Out of demo mode the environment is known to be complete without reading it.
    expect(html).toContain("Environment complete");
  });

  it("cannot check the environment in demo mode without the settings", () => {
    const html = page(ana, createElement(Setup, { facts: facts(null, true) }));
    expect(html).toContain("1 · ENVIRONMENT");
    expect(html).not.toContain("Environment complete");
    expect(html).not.toMatch(/settings? needs? you/);
    expect(html).toContain("only to an admin signed in by");
    expect(html).toContain("openssl rand -base64 32");
    expect(html.match(/Cannot check from here/g)?.length).toBeGreaterThan(3);
  });

  it("names the admin secret at stop 5 only to whoever signed in with it", () => {
    const demo = facts(null, true);
    const without = firstAdmin(demo, null, null, false);
    expect(String(without.text)).not.toMatch(/secret/i);
    expect(String(firstAdmin(demo, null, null, true).text)).toContain(
      "admin secret",
    );
  });
});
