import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaymentSummary } from "@/app/admin/payments/actions";
import { PaymentAdmin, PaymentPanel } from "@/app/admin/payments/payment-admin";
import {
  refundRequestId,
  spendRefundRequestId,
} from "@/app/admin/payments/request-id";
import type { ActionState, PeerSummary } from "@/app/admin/peers/actions";
import { Refused } from "@/app/admin/peers/connect/connect";
import { HubParties, PushMode } from "@/app/admin/peers/[id]/peer-page";
import { PeerList } from "@/app/admin/peers/peer-list";
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
import PaymentsPage from "@/app/admin/payments/page";
import ConnectPage from "@/app/admin/peers/connect/page";
import PeersPage from "@/app/admin/peers/page";
import TokensPage from "@/app/admin/tokens/page";
import SetupPage from "@/app/page";
import {
  buildStops,
  firstAdmin,
  Setup,
  StatusView,
  type SetupFacts,
} from "@/app/setup";
import { SignIn } from "@/app/admin/sign-in/sign-in-form";
import { passes, STOP_NAMES, type SetupStatus } from "@/lib/setup/checks";
import { readSetupStatus } from "@/lib/setup/status";
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

// The sign-in form asks for the router; nothing here navigates.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  usePathname: () => "/",
}));

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
      pushMode: "hub",
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
    expect(html).toContain(
      "Not trusted: nothing is pulled from it, no command is sent to it and nothing it sends is accepted.",
    );
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
        peer: peer({ hub: { parties: [], pushMode: "hub" } }),
        send: async () => ({}),
      }),
    );
    expect(html).toContain("Connected, but idle: no party is trusted yet.");
    expect(html).toContain("Accept the CPOs you have an agreement with.");
    expect(html).toContain("tokens already go to the hub");
    const perParty = renderToStaticMarkup(
      createElement(HubParties, {
        peer: peer({ hub: { parties: [], pushMode: "per_party" } }),
        send: async () => ({}),
      }),
    );
    expect(perParty).toContain(
      "Pulls and token pushes start with the first one.",
    );
  });

  it("words a party's trust by the push mode", () => {
    const render = (pushMode: "hub" | "per_party") =>
      renderToStaticMarkup(
        createElement(HubParties, {
          peer: { ...hub, hub: { ...hub.hub!, pushMode } },
          send: async () => ({}),
        }),
      );
    const toHub = render("hub");
    expect(toHub).toContain("Trusted: pulled from and sent commands");
    expect(toHub).toContain("Tokens still reach it if the hub passes them on.");
    expect(toHub).not.toContain("nothing is sent or accepted");
    expect(toHub).toContain(
      "send them no command and refuse what arrives in their name.",
    );
    const each = render("per_party");
    expect(each).toContain("Trusted: pulled from, sent commands and tokens");
    expect(each).toContain("send them no command or token and refuse");
    expect(each).not.toContain("Tokens still reach it");
  });

  it("shows the Token pushes card with the hub's mode selected, and sends a change", async () => {
    const html = (pushMode: "hub" | "per_party") =>
      renderToStaticMarkup(
        createElement(PushMode, {
          peer: { ...hub, hub: { ...hub.hub!, pushMode } },
          send: async () => ({}),
        }),
      );
    const toHub = html("hub");
    expect(toHub).toContain("Token pushes");
    expect(toHub).toMatch(/<option value="hub" selected="">/);
    expect(toHub).toContain("the hub decides which CPOs receive it");
    const each = html("per_party");
    expect(each).toMatch(/<option value="per_party" selected="">/);
    expect(each).toContain("queues every active token for the hub once");
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
  const read = { baseUrl: "https://emsp.example.com", holds: ["€25.00"] };
  const facts = (
    settings: SetupFacts["settings"],
    demo = false,
    publicView: SetupFacts["publicView"] = null,
  ): SetupFacts => ({
    demo,
    codesPerHour: 5,
    version: "2.2.1",
    party: "NL-EXA",
    settings,
    publicView,
  });
  const T = "2026-11-24T12:00:00.000Z";
  const ago = (ms: number) => new Date(Date.parse(T) - ms).toISOString();
  /** A live deployment where all six checks pass. */
  const healthy = (over: Partial<SetupStatus> = {}): SetupStatus => ({
    checkedAt: T,
    demo: false,
    environment: {
      required: 6,
      missing: [],
      malformed: [],
      malformedRequired: 0,
      demoForced: false,
      stripeKey: true,
      webhookSecret: true,
      cronSecret: true,
    },
    database: {
      state: "ok",
      shipped: 14,
      applied: 14,
      pending: [],
      newest: "202611240001_hub_push_mode.sql",
    },
    webhook: {
      lastSigned: { at: ago(120_000), result: "handled" },
      lastRefused: null,
    },
    job: {
      runs: [{ at: ago(600_000), ok: true, sinceLastS: 60 }],
      sweptAt: ago(40_000),
    },
    admins: 2,
    peers: { total: 3, registered: 3, hubs: 1, trustedParties: 2 },
    ...over,
  });
  const view = (status: SetupStatus, who: Who = ana, f = facts(read)) =>
    page(who, createElement(StatusView, { facts: f, status }));
  const NONE = STOP_NAMES.map((name) => ({ name, pass: false }));

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
    expect(sent.party).toBeNull();
    expect(Object.keys(sent).sort()).toEqual([
      "codesPerHour",
      "demo",
      "party",
      "publicView",
      "settings",
      "version",
    ]);
    // Demo mode has no admin, so the public view is there: six names, none done.
    expect(sent.publicView).toEqual(NONE);
    const data = JSON.stringify(element.props);
    // No environment variable's name, whatever it is called.
    expect(data).not.toMatch(/[A-Z][A-Z0-9]+_[A-Z0-9_]+/);
    for (const e of errors) expect(data).not.toContain(e);
    // Beside the six fixed names, nothing about payments, the job or a secret.
    const rest = JSON.stringify({ ...sent, publicView: null });
    expect(rest).not.toMatch(
      /must |missing|errors|malformed|stripe|webhook|cron|hold|secret/i,
    );
    // And the page as rendered for them.
    const html = page(null, element);
    expect(html).toContain("Sign in as an admin to see this deployment");
    expect(html).not.toMatch(/[A-Z][A-Z0-9]+_[A-Z0-9_]+/);
    expect(html).not.toMatch(/must |is not set|Malformed|Missing|secret/i);
  });

  it("the server reads the address and the hold for an admin signed in by email, and no public view", async () => {
    for (const name of LIVE_REQUIRED) delete process.env[name];
    Object.assign(process.env, MALFORMED);
    signedInAdmin.current = { userId: "u1", ...ana! };
    const element = await SetupPage();
    const sent = (element.props as { facts: SetupFacts }).facts;
    expect(Object.keys(sent.settings!).sort()).toEqual(["baseUrl", "holds"]);
    expect(sent.publicView).toBeNull();
    expect(sent.party).toMatch(/^[A-Z]{2}-/);
    // What the stops found comes from the status read, by name only.
    const status = await readSetupStatus();
    const html = view(status, ana, sent);
    expect(html).toContain("<code>PUBLIC_BASE_URL</code> is not set");
    expect(html).toContain("<code>HOLD_AMOUNTS</code>");
    for (const sentToPage of [element.props, status])
      expect(JSON.stringify(sentToPage)).not.toContain(MALFORMED.ADMIN_SECRET);
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

  it("the layout reads no setup status: only a signed-in admin's page asks for it", () => {
    const layout = readFileSync(join(__dirname, "../app/layout.tsx"), "utf8");
    expect(layout).not.toMatch(/readSetupStatus|publicSetupView|lib\/setup/);
    // The full read has two callers: the admin action and the public view's own code.
    const users = files(join(__dirname, "../app")).filter((f) =>
      /readSetupStatus/.test(readFileSync(f, "utf8")),
    );
    expect(users.map((f) => f.split("/app/")[1])).toEqual([
      "admin/setup/actions.ts",
    ]);
  });

  it("shows the sign-in prompt only once an admin exists, even if the page were given the settings", () => {
    const html = page(null, createElement(Setup, { facts: facts(read) }));
    expect(html).toContain("Sign in as an admin to see this deployment");
    expect(html).toContain('href="/admin/sign-in"');
    expect(html).not.toMatch(/STRIPE|CRON_SECRET|Setup checklist|NL-EXA/);
    expect(html).not.toMatch(/Setup progress|Not done|Scheduled job/i);
    expect(html).not.toMatch(/<input|<ol/);
  });

  it("before the first admin: the six names, Done or Not done, the prompt, and nothing else", () => {
    const stops = STOP_NAMES.map((name, i) => ({ name, pass: i < 2 }));
    const html = page(
      null,
      createElement(Setup, { facts: facts(read, false, stops) }),
    );
    expect(html).toContain("Setup so far: 2 of 6 done");
    for (const name of STOP_NAMES) expect(html).toContain(name.toUpperCase());
    expect(html.match(/>Done</g)).toHaveLength(2);
    expect(html.match(/>Not done</g)).toHaveLength(4);
    expect(html).toContain("Sign in as an admin to see this deployment");
    // No fix, no setting, no address, no identity, no field.
    expect(html).not.toMatch(/[A-Z][A-Z0-9]+_[A-Z0-9_]+/);
    expect(html).not.toMatch(/NL-EXA|emsp\.example|€|npm run|openssl|<input/);
    expect(html).not.toContain("Setup checklist");
    // The text of the view, less the fixed names and the count of them: no other
    // digit, so no time and no count of anything.
    let text = html
      .replace(/<[^>]+>/g, " ")
      .replaceAll("&#x27;", "'")
      .replace("Setup so far: 2 of 6 done", "")
      .replace("6-digit code", "");
    for (const [i, name] of STOP_NAMES.entries())
      text = text.replace(`${i + 1} · ${name.toUpperCase()}`, "");
    expect(text).not.toMatch(/\d/);
  });

  it("shows a signed-in admin the stops, with the unset settings by name", () => {
    const html = view(
      healthy({
        environment: {
          ...healthy().environment,
          stripeKey: false,
          cronSecret: false,
        },
      }),
    );
    expect(html).toContain("Setup checklist");
    expect(html).toContain("Environment complete");
    expect(html).toContain("<code>STRIPE_SECRET_KEY</code>");
    expect(html).toContain("<code>CRON_SECRET</code> is not set");
    expect(html).toContain("Setting up: 4 of 6 done");
    expect(html).toContain("https://emsp.example.com/api/webhooks/stripe");
  });

  it("an admin-secret sign-in gets the stops, with a placeholder for the address", () => {
    // The server did not see the secret when it rendered: no address, no party.
    const html = view(
      healthy({ webhook: { lastSigned: null, lastRefused: null } }),
      null,
      { ...facts(null), party: null },
    );
    expect(html).toContain("No signed payment event has arrived");
    expect(html).toContain("https://&lt;this deployment&gt;/api/webhooks/");
    expect(html).not.toContain("emsp.example.com");
    expect(html).toContain("<code>GET /api/v1/status</code>");
  });

  it("is called Health, with every stop open, once all six checks pass", () => {
    const html = view(healthy());
    expect(html).toContain("<h1>Everything is working</h1>");
    expect(html).toContain("<span>Health</span>");
    expect(html).toContain('aria-label="Health checks"');
    expect(html).toContain("<h2>Live</h2>");
    expect(html.match(/<details open="">/g)).toHaveLength(6);
    expect(html).toContain("All 14 migrations this build ships are applied");
    expect(html).toContain("The job runs every minute");
    expect(html).toContain("2 users are on the admin list");
    expect(html).not.toContain("Get this network live");
    // One failing check and it is Setup again.
    const late = view(
      healthy({ job: { runs: healthy().job!.runs, sweptAt: ago(720_000) } }),
    );
    expect(late).toContain("Get this network live");
    expect(late).toContain("The job stopped 12 minutes ago");
    expect(late).toContain("payment_sweep_stale");
    expect(late).toContain("Live, but card holds are refused");
  });

  it("a stop reads Done exactly when its check passes", () => {
    const h = healthy();
    const who = { admin: ana, lastEmail: null, hasSecret: false };
    const cases: Partial<SetupStatus>[] = [
      {},
      { demo: true, database: null },
      { database: { ...h.database!, state: "empty", applied: 0 } },
      {
        database: {
          ...h.database!,
          state: "pending",
          applied: 13,
          pending: ["202611240001_hub_push_mode.sql"],
        },
      },
      { database: { ...h.database!, state: "unreachable", applied: 0 } },
      { environment: { ...h.environment, webhookSecret: false } },
      { webhook: null },
      { webhook: { lastSigned: null, lastRefused: { at: ago(5_000) } } },
      {
        webhook: {
          lastSigned: { at: ago(5_000), result: "failed" },
          lastRefused: null,
        },
      },
      {
        webhook: {
          lastSigned: h.webhook!.lastSigned,
          lastRefused: { at: ago(1_000) },
        },
      },
      { environment: { ...h.environment, cronSecret: false } },
      { job: null },
      { job: { runs: [], sweptAt: null } },
      { job: { runs: [], sweptAt: ago(30_000) } },
      { job: { runs: [], sweptAt: ago(900_000) } },
      { job: { runs: h.job!.runs, sweptAt: ago(900_000) } },
      {
        job: {
          runs: [{ at: ago(60_000), ok: false, sinceLastS: 60 }],
          sweptAt: ago(30_000),
        },
      },
      {
        job: {
          runs: [{ at: ago(60_000), ok: true, sinceLastS: 86_400 }],
          sweptAt: ago(30_000),
        },
      },
      {
        job: {
          runs: [{ at: ago(86_400_000), ok: true, sinceLastS: 86_400 }],
          sweptAt: ago(80_000_000),
        },
      },
      { admins: 0 },
      { admins: null },
      { peers: null },
      { peers: { total: 1, registered: 0, hubs: 0, trustedParties: 0 } },
    ];
    for (const change of cases) {
      const status = healthy(change);
      const stops = buildStops(status, facts(read, status.demo), who);
      expect(
        stops.map((stop) => stop.kind === "ok"),
        JSON.stringify(change),
      ).toEqual(passes(status, Date.parse(T)));
      // Every stop that is not done says what it is, and renders.
      expect(view(status)).toContain("1 · ENVIRONMENT");
    }
  });

  it("words the database, webhook and job stops for what was found", () => {
    const h = healthy();
    // With no tables nothing else can be read (lib/setup/status.ts).
    const empty = view(
      healthy({
        database: { ...h.database!, state: "empty", applied: 0 },
        webhook: null,
        job: null,
        admins: 0,
        peers: { total: 0, registered: 0, hubs: 0, trustedParties: 0 },
      }),
    );
    expect(empty).toContain("The database has no tables");
    expect(empty).toContain("Not live: 1 of 6 done");
    expect(empty).toContain("npm run db:migrate");
    const pending = view(
      healthy({
        database: {
          ...h.database!,
          state: "pending",
          applied: 13,
          pending: ["202611240001_hub_push_mode.sql"],
        },
      }),
    );
    expect(pending).toContain("One migration is pending");
    expect(pending).toContain("<code>202611240001_hub_push_mode.sql</code>");
    const refused = view(
      healthy({
        webhook: { lastSigned: null, lastRefused: { at: ago(300_000) } },
      }),
    );
    expect(refused).toContain("the signature does not match");
    expect(refused).toContain("5 minutes ago (2026-11-24 11:55 UTC)");
    const daily = view(
      healthy({
        job: {
          runs: [{ at: ago(3_600_000), ok: true, sinceLastS: 86_400 }],
          sweptAt: ago(3_600_000),
        },
      }),
    );
    expect(daily).toContain("The job runs once a day: card holds are refused");
    expect(daily).toContain("Free hosting limit");
    const none = view(healthy({ admins: 0 }));
    expect(none).toContain("No admin exists yet");
    expect(none).toContain("insert into public.emsp_admins");
    expect(none).toContain("Almost live: 5 of 6 done");
  });

  it("in demo mode every later stop waits for the environment", () => {
    const status = healthy({
      demo: true,
      database: null,
      environment: {
        ...healthy().environment,
        missing: ["OCPI_TOKEN_ENCRYPTION_KEY"],
        demoForced: true,
      },
    });
    const html = view(status, ana, facts(read, true));
    expect(html).toContain("Demo mode: 0 of 6 done");
    expect(html).toContain("One setting needs you");
    expect(html).toContain("openssl rand -base64 32");
    expect(html).toContain("<code>DEMO_MODE</code> is set");
    expect(html.match(/>Waiting</g)).toHaveLength(5);
    expect(html).toContain("The mock CPO stands in");
  });

  it("the sign-in page in demo mode says whether the admin secret is set, and only that", () => {
    const signIn = (secretEnabled: boolean) =>
      renderToStaticMarkup(
        createElement(AdminProvider, {
          admin: null,
          demo: true,
          children: createElement(SignIn, { codesPerHour: 5, secretEnabled }),
        }),
      );
    const without = signIn(false);
    expect(without).toContain("ADMIN_SECRET is not set on this server");
    expect(without).not.toContain("Use the admin secret instead");
    const withSecret = signIn(true);
    expect(withSecret).not.toContain("is not set on this server");
    // The one variable the page names is that one, with or without it.
    for (const html of [without, withSecret])
      expect(
        [...new Set(html.match(/[A-Z][A-Z0-9]+_[A-Z0-9_]+/g) ?? [])].filter(
          (name) => name !== "ADMIN_SECRET",
        ),
      ).toEqual([]);
  });

  // Every other page whose server part reads the configuration.
  const PAGES: [string, () => Promise<unknown>][] = [
    ["peers", () => PeersPage()],
    ["connect", () => ConnectPage()],
    ["tokens", () => TokensPage()],
    [
      "payments",
      () => PaymentsPage({ searchParams: Promise.resolve({ find: "x" }) }),
    ],
  ];
  // A real-looking deployment: the values a visitor must not be sent.
  const REAL = {
    PUBLIC_BASE_URL: "https://charge.example.org",
    EMSP_COUNTRY_CODE: "DE",
    EMSP_PARTY_ID: "QRS",
    STRIPE_SECRET_KEY: `sk_test_${"a1B2".repeat(8)}`,
  };

  it("no page's data tells a visitor the address, the identity or whether Stripe is set", async () => {
    Object.assign(process.env, REAL);
    for (const [name, render] of PAGES) {
      const data = JSON.stringify(await render());
      expect(data, name).not.toMatch(/charge\.example\.org|localhost|QRS/);
      expect(data, name).not.toMatch(/"stripeSet":(true|false)/);
      expect(data, name).not.toMatch(/"(versionsUrl|tokensUrl)":"/);
      expect(data, name).not.toMatch(/[A-Z][A-Z0-9]+_[A-Z0-9_]+/);
    }
    // The same pages with the address unset: nothing changes for a visitor.
    const before = await Promise.all(PAGES.map(([, r]) => r()));
    process.env.PUBLIC_BASE_URL = "";
    process.env.STRIPE_SECRET_KEY = "";
    process.env.EMSP_PARTY_ID = "";
    const after = await Promise.all(PAGES.map(([, r]) => r()));
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("an admin signed in by email is sent them", async () => {
    Object.assign(process.env, REAL);
    signedInAdmin.current = { userId: "u1", ...ana! };
    const data = JSON.stringify(
      await Promise.all(PAGES.map(([, render]) => render())),
    );
    expect(data).toContain(
      '"versionsUrl":"https://charge.example.org/ocpi/versions"',
    );
    expect(data).toContain('"party":"DE-QRS"');
    expect(data).toContain('"tokensUrl":"https://charge.example.org/ocpi/');
    expect(data).toContain('"stripeSet":true');
  });

  it("an admin-secret sign-in is told how to find what the server did not send", () => {
    const peers = page(
      ana,
      createElement(PeerList, {
        versionsUrl: null,
        party: null,
        version: "2.2.1",
      }),
    );
    expect(peers).toContain("<code>GET /api/v1/status</code>");
    expect(peers).toContain("<code>/ocpi/versions</code>");
    expect(peers).toContain("only to an admin signed in by email");
    const payments = page(
      ana,
      createElement(PaymentAdmin, { demo: false, stripeSet: null }),
    );
    expect(payments).toContain("Whether it is set shows here only to");
    expect(payments).not.toContain("Payments are not set up");
    // Demo mode says the same as before, and an email admin still gets the warning.
    expect(
      page(ana, createElement(PaymentAdmin, { demo: true, stripeSet: null })),
    ).not.toContain("Whether it is set");
    expect(
      page(ana, createElement(PaymentAdmin, { demo: false, stripeSet: false })),
    ).toContain("Payments are not set up");
  });

  it("names the admin secret at stop 5 only to whoever signed in with it", () => {
    const demo = healthy({ demo: true, database: null });
    const without = firstAdmin(demo, null, null, false);
    expect(String(without.text)).not.toMatch(/secret/i);
    expect(String(firstAdmin(demo, null, null, true).text)).toContain(
      "admin secret",
    );
  });
});
