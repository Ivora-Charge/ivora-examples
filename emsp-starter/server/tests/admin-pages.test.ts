import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionState, PeerSummary } from "@/app/admin/peers/actions";
import { Refused } from "@/app/admin/peers/connect/connect";
import { HubParties } from "@/app/admin/peers/[id]/peer-page";
import { moduleName, viewOf } from "@/app/admin/peers/peer-view";
import { tokenRefused } from "@/app/admin/peers/refused";
import {
  firstAdminSql,
  LIMITED_MESSAGE,
  signInProblem,
} from "@/app/admin/sign-in/states";
import { AuthRateLimitedError, type AuthProvider } from "@/lib/accounts/auth";
import {
  requestCode,
  resetSignInLimitsForTests,
  SIGN_IN_LIMITS,
  SignInError,
} from "@/lib/accounts/sign-in";
import { explainMessage } from "@/lib/admin/errors";

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
