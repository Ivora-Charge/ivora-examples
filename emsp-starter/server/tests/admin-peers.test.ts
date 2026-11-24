import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "next/headers",
  async () => (await import("./support/request")).nextHeaders,
);

import {
  connectPeerAction,
  invitePeerAction,
  listPeersAction,
  managePeerAction,
} from "@/app/admin/peers/actions";
import { setLocationStoreForTests } from "@/lib/locations/registry";
import { MemoryLocationStore } from "@/lib/locations/store";
import { createMockCpo } from "@/lib/mock-cpo";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { MemoryPeerStore } from "@/lib/ocpi/store";
import {
  ADMIN_LIMIT,
  checkAdminSecret,
  isAdminSecret,
  issueSecretSession,
  resetAdminLimitForTests,
} from "@/lib/server/admin";
import {
  emspHandler,
  inProcessNetwork,
  installNetwork,
  uninstallNetwork,
  LIVE_ENV,
} from "./support/network";

import { resetRequest, signInWithSecret } from "./support/request";

const SECRET = "s".repeat(32);
const saved = { ...process.env };
let store: MemoryPeerStore;
let fetchSpy: ReturnType<typeof vi.fn>;

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeEach(() => {
  resetAdminLimitForTests();
  for (const k of [...Object.keys(LIVE_ENV), "DEMO_MODE", "ADMIN_SECRET"])
    delete process.env[k];
  store = new MemoryPeerStore();
  setPeerStoreForTests(store);
  setLocationStoreForTests(new MemoryLocationStore());
  fetchSpy = vi.fn(() => {
    throw new Error("no network in tests");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  setPeerStoreForTests(undefined);
  setLocationStoreForTests(undefined);
  uninstallNetwork();
  resetRequest();
  process.env = { ...saved };
});

describe("admin secret (temporary admin gate)", () => {
  it("is off without ADMIN_SECRET, or with one under 32 characters", async () => {
    expect(isAdminSecret("")).toBe(false);
    process.env.ADMIN_SECRET = "short";
    expect(isAdminSecret("short")).toBe(false);
    expect(issueSecretSession()).toBeNull();
    const res = await invitePeerAction({}, form({ label: "x" }));
    expect(res).toMatchObject({
      ok: false,
      message: expect.stringMatching(/disabled/),
    });
    expect(store.peers.size).toBe(0);
  });

  it("refuses every action without a session, whatever the form carries", async () => {
    process.env.ADMIN_SECRET = SECRET;
    for (const action of [
      connectPeerAction,
      invitePeerAction,
      managePeerAction,
      listPeersAction,
    ]) {
      resetAdminLimitForTests();
      expect(await action({}, form({ label: "x" }))).toMatchObject({
        ok: false,
        code: "signed_out",
      });
      // The secret itself in a form opens nothing: the gate reads no field.
      expect(
        await action({}, form({ label: "x", adminSecret: SECRET })),
      ).toMatchObject({ ok: false, code: "signed_out" });
    }
    expect(store.peers.size).toBe(0);
  });

  it("rate limits wrong secrets, per client and in total", async () => {
    process.env.ADMIN_SECRET = SECRET;
    for (let i = 0; i < ADMIN_LIMIT.perClient; i++)
      expect(checkAdminSecret("wrong", "192.0.2.1")).toBe("wrong");
    // Limited: even the right secret is not compared now.
    expect(checkAdminSecret(SECRET, "192.0.2.1")).toBe("limited");
    // Another client has its own count.
    expect(checkAdminSecret(SECRET, "192.0.2.2")).toBe("ok");

    resetAdminLimitForTests();
    const t0 = Date.now();
    for (let i = 0; i < ADMIN_LIMIT.total; i++)
      expect(checkAdminSecret("wrong", `10.0.0.${i}`, t0)).toBe("wrong");
    expect(checkAdminSecret(SECRET, "192.0.2.1", t0)).toBe("limited");
    // The window passes.
    expect(
      checkAdminSecret(SECRET, "192.0.2.1", t0 + ADMIN_LIMIT.windowMs),
    ).toBe("ok");
  });

  it("without a client address, only the total cap applies", async () => {
    process.env.ADMIN_SECRET = SECRET;
    for (let i = 0; i < ADMIN_LIMIT.total - 1; i++)
      expect(checkAdminSecret("wrong", null)).toBe("wrong");
    // No per-client count: 49 wrong secrets from nowhere in particular lock nobody.
    expect(checkAdminSecret(SECRET, null)).toBe("ok");
    expect(checkAdminSecret("wrong", null)).toBe("wrong");
    expect(checkAdminSecret(SECRET, null)).toBe("limited");
  });

  it("counts a session of another secret apart from wrong secrets: the gate refuses it, then pauses sessions, and the secret still works", async () => {
    const forged = () => {
      process.env.ADMIN_SECRET = "x".repeat(32);
      signInWithSecret();
      process.env.ADMIN_SECRET = SECRET;
    };
    for (let i = 0; i < ADMIN_LIMIT.total; i++) {
      forged();
      expect((await listPeersAction({}, form({}))).code).toBe("signed_out");
    }
    // 50 that did not check out: now not even a valid session is accepted.
    signInWithSecret();
    expect((await listPeersAction({}, form({}))).code).toBe("session_limited");
    // None was a wrong secret. A right one also starts the sessions' count afresh.
    expect(checkAdminSecret(SECRET, null)).toBe("ok");
    signInWithSecret();
    expect((await listPeersAction({}, form({}))).ok).toBe(true);
  });
});

describe("admin peer actions", () => {
  beforeEach(() => {
    process.env.ADMIN_SECRET = SECRET;
    signInWithSecret();
  });

  it("in demo mode, invites but refuses to contact a CPO", async () => {
    const invited = await invitePeerAction({}, form({ label: "Some CPO" }));
    expect(invited).toMatchObject({
      ok: true,
      tokenA: expect.stringMatching(/^[\w-]{43}$/),
      versionsUrl: "http://localhost:3000/ocpi/versions",
      peer: { label: "Some CPO", status: "pending", direction: "inbound" },
    });
    const connected = await connectPeerAction(
      {},
      form({
        label: "CPO",
        versionsUrl: "https://cpo.example.test/ocpi/versions",
        tokenA: "a",
      }),
    );
    expect(connected).toMatchObject({
      ok: false,
      message: "Demo mode: refused to register at a CPO. Nothing was sent.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("in live mode, connects, lists, rotates and unregisters with the mock CPO", async () => {
    Object.assign(process.env, LIVE_ENV);
    const net = inProcessNetwork({
      "emsp.example.test": emspHandler,
      "mock-cpo.example.test": (r) => cpo.handle(r),
    });
    const cpo = createMockCpo({ transport: net.transport });
    installNetwork(net.transport);
    const tokenA = cpo.issueTokenA();

    const connected = await connectPeerAction(
      {},
      form({
        label: "Mock CPO",
        versionsUrl: cpo.urls.versions,
        tokenA,
      }),
    );
    expect(connected).toMatchObject({
      ok: true,
      peer: {
        status: "registered",
        parties: ["CPO ZZ-MCK (Mock CPO)"],
        modules: [
          "cdrs",
          "commands",
          "credentials",
          "locations",
          "sessions",
          "tariffs",
          "tokens",
        ],
      },
    });
    const id = connected.peer!.id;

    const listed = await listPeersAction({}, form({}));
    expect(listed.peers).toHaveLength(1);
    // Summaries carry no token material.
    expect(JSON.stringify(listed)).not.toMatch(/v1:|ciphertext/i);
    expect(JSON.stringify(listed)).not.toContain(tokenA);

    const rotated = await managePeerAction(
      {},
      form({ peerId: id, intent: "rotate" }),
    );
    expect(rotated).toMatchObject({
      ok: true,
      message: "Tokens rotated with Mock CPO.",
    });
    const gone = await managePeerAction(
      {},
      form({ peerId: id, intent: "unregister" }),
    );
    expect(gone).toMatchObject({ ok: true, peer: { status: "unregistered" } });
    expect(cpo.state.emsp).toBeUndefined();
  });

  it("explains handshake failures without leaking the token", async () => {
    Object.assign(process.env, LIVE_ENV);
    const net = inProcessNetwork({
      "mock-cpo.example.test": (r) => cpo.handle(r),
    });
    const cpo = createMockCpo({ transport: net.transport });
    installNetwork(net.transport);
    const res = await connectPeerAction(
      {},
      form({
        label: "Mock CPO",
        versionsUrl: cpo.urls.versions,
        tokenA: "not-the-right-token",
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/refused our token \(HTTP 401\)/);
    expect(res.message).not.toContain("not-the-right-token");
    // A first registration was refused: its one-time token, not a permanent one.
    expect(res.nextStep).toMatch(/new one-time token/);
    expect(res.nextStep).not.toMatch(/Rotate/);
  });

  it("rejects a malformed peer ID", async () => {
    expect(
      await managePeerAction({}, form({ peerId: "../x", intent: "rotate" })),
    ).toMatchObject({ ok: false, message: "Peer ID must be a UUID." });
  });
});
