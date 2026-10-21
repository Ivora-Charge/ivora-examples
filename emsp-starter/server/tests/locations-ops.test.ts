import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cronRoute from "@/app/api/cron/ocpi-sync/route";
import * as searchRoute from "@/app/api/v1/locations/route";
import { syncPeerAction } from "@/app/admin/peers/actions";
import { createMockCpo, type MockCpo } from "@/lib/mock-cpo";
import { setLocationStoreForTests } from "@/lib/locations/registry";
import { MemoryLocationStore } from "@/lib/locations/store";
import { connectToCpo, invitePeer, unregisterPeer } from "@/lib/ocpi/handshake";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { MemoryPeerStore } from "@/lib/ocpi/store";
import { authorizationHeader } from "@/lib/ocpi/tokens";
import { ocpiTimestamp } from "@/lib/ocpi/types";
import { adminClientKey, resetAdminLimitForTests } from "@/lib/server/admin";
import { setTokenStoreForTests } from "@/lib/tokens/registry";
import { MemoryTokenStore } from "@/lib/tokens/store";
import {
  emspHandler,
  inProcessNetwork,
  installNetwork,
  LIVE_ENV,
  uninstallNetwork,
} from "./support/network";

const SECRET = "s".repeat(32);
const CRON = "c".repeat(40);
const saved = { ...process.env };
let peers: MemoryPeerStore;
let locations: MemoryLocationStore;
let cpo: MockCpo;
let net: ReturnType<typeof inProcessNetwork>;

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** A CPO platform that only speaks OCPI 2.1.1, or lists no credentials module. */
const oldCpo = async (r: Request) => {
  const path = new URL(r.url).pathname;
  const ok = (data: unknown) =>
    Response.json({ data, status_code: 1000, timestamp: ocpiTimestamp() });
  if (path === "/v211/versions")
    return ok([{ version: "2.1.1", url: "https://old-cpo.example.test/v211" }]);
  if (path === "/v221/versions")
    return ok([{ version: "2.2.1", url: "https://old-cpo.example.test/v221" }]);
  if (path === "/v221")
    return ok({
      version: "2.2.1",
      endpoints: [
        {
          identifier: "locations",
          role: "SENDER",
          url: "https://old-cpo.example.test/loc",
        },
      ],
    });
  return new Response("not found", { status: 404 });
};

beforeEach(() => {
  resetAdminLimitForTests();
  Object.assign(process.env, LIVE_ENV, { ADMIN_SECRET: SECRET });
  delete process.env.DEMO_MODE;
  delete process.env.CRON_SECRET;
  peers = new MemoryPeerStore();
  locations = new MemoryLocationStore();
  setPeerStoreForTests(peers);
  setLocationStoreForTests(locations);
  setTokenStoreForTests(new MemoryTokenStore());
  net = inProcessNetwork({
    "emsp.example.test": emspHandler,
    "mock-cpo.example.test": (r) => cpo.handle(r),
    "old-cpo.example.test": oldCpo,
  });
  cpo = createMockCpo({ transport: net.transport });
  installNetwork(net.transport);
});

afterEach(() => {
  uninstallNetwork();
  setPeerStoreForTests(undefined);
  setLocationStoreForTests(undefined);
  setTokenStoreForTests(undefined);
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const connect = () =>
  connectToCpo(
    {
      label: "Mock CPO",
      versionsUrl: cpo.urls.versions,
      tokenA: cpo.issueTokenA(),
    },
    { store: peers },
  );

describe("admin: pull locations and tariffs", () => {
  it("pulls tariffs then locations and says what it stored", async () => {
    const peer = await connect();
    const res = await syncPeerAction(
      {},
      form({ peerId: peer.id, intent: "changes", adminSecret: SECRET }),
    );
    expect(res).toEqual({
      ok: true,
      message: "Pulled from Mock CPO. tariffs: 6 stored; locations: 6 stored.",
    });
    expect(locations.locations.size).toBe(6);
    const again = await syncPeerAction(
      {},
      form({ peerId: peer.id, intent: "full", adminSecret: SECRET }),
    );
    expect(again.ok).toBe(true);
  });

  it("needs the admin secret and a peer ID, and is refused in demo mode", async () => {
    const peer = await connect();
    expect(
      await syncPeerAction({}, form({ peerId: peer.id, adminSecret: "wrong" })),
    ).toEqual({ ok: false, message: "Wrong admin secret." });
    expect(
      await syncPeerAction({}, form({ peerId: "x", adminSecret: SECRET })),
    ).toEqual({ ok: false, message: "Peer ID must be a UUID." });
    process.env.DEMO_MODE = "true";
    const demo = await syncPeerAction(
      {},
      form({ peerId: peer.id, adminSecret: SECRET }),
    );
    expect(demo).toEqual({
      ok: false,
      message:
        "Demo mode: refused to pull locations and tariffs from a CPO. Nothing was sent.",
    });
  });
});

describe("scheduled pull (cron)", () => {
  const call = (auth?: string) =>
    cronRoute.GET(
      new Request("https://emsp.example.test/api/cron/ocpi-sync", {
        headers: auth ? { Authorization: auth } : {},
      }),
    );

  it("is disabled without CRON_SECRET and refuses a wrong one", async () => {
    expect((await call(`Bearer ${CRON}`)).status).toBe(503);
    process.env.CRON_SECRET = "short";
    expect((await call("Bearer short")).status).toBe(503);
    process.env.CRON_SECRET = CRON;
    expect((await call()).status).toBe(401);
    expect((await call(`Bearer ${CRON}x`)).status).toBe(401);
    expect((await call(CRON)).status).toBe(401);
  });

  it("pulls every registered peer, and nothing in demo mode", async () => {
    process.env.CRON_SECRET = CRON;
    const peer = await connect();
    const res = await call(`Bearer ${CRON}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mode: "live",
      tokens: { expired: 0, pushes: { sent: 0, failed: 0, dropped: 0 } },
      results: [
        expect.objectContaining({
          peerId: peer.id,
          module: "tariffs",
          ok: true,
        }),
        expect.objectContaining({
          peerId: peer.id,
          module: "locations",
          ok: true,
        }),
      ],
    });
    process.env.DEMO_MODE = "true";
    const before = net.calls.length;
    expect(await (await call(`Bearer ${CRON}`)).json()).toMatchObject({
      mode: "demo",
      results: [],
    });
    expect(net.calls.length).toBe(before);
  });
});

describe("live search shows registered peers only", () => {
  it("drops a peer's locations from the app when it unregisters", async () => {
    const peer = await connect();
    process.env.CRON_SECRET = CRON;
    await cronRoute.GET(
      new Request("https://emsp.example.test/api/cron/ocpi-sync", {
        headers: { Authorization: `Bearer ${CRON}` },
      }),
    );
    const search = async () =>
      (
        await (
          await searchRoute.GET(
            new Request("https://emsp.example.test/api/v1/locations"),
          )
        ).json()
      ).total;
    expect(await search()).toBe(5);
    await unregisterPeer(peer.id, { store: peers });
    expect(await search()).toBe(0);
  });
});

describe("credentials: a CPO without 2.2.1 or without a credentials module", () => {
  const post = async (versionsUrl: string) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const invite = await invitePeer({ label: "Old CPO" }, { store: peers });
    const res = await net.transport(
      "https://emsp.example.test/ocpi/2.2.1/credentials",
      {
        method: "POST",
        headers: {
          Authorization: authorizationHeader(invite.tokenA),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token: "their-token-b",
          url: versionsUrl,
          roles: [
            {
              role: "CPO",
              party_id: "OLD",
              country_code: "ZZ",
              business_details: { name: "Old CPO" },
            },
          ],
        }),
      },
    );
    return { status: res.status, body: await res.json() };
  };

  it("answers 3002 and 3003 with fixed messages", async () => {
    expect(
      await post("https://old-cpo.example.test/v211/versions"),
    ).toMatchObject({
      status: 400,
      body: { status_code: 3002, status_message: "Peer offers no OCPI 2.2.1" },
    });
    expect(
      await post("https://old-cpo.example.test/v221/versions"),
    ).toMatchObject({
      status: 400,
      body: {
        status_code: 3003,
        status_message: "Peer has no credentials endpoint",
      },
    });
  });
});

describe("admin rate-limit client key", () => {
  const key = (h: Record<string, string>) => adminClientKey(new Headers(h));

  it("prefers the platform's client-IP headers, then the proxy's own X-Forwarded-For entry", () => {
    expect(
      key({
        "x-vercel-forwarded-for": "203.0.113.9",
        "x-real-ip": "198.51.100.1",
        "x-forwarded-for": "1.1.1.1, 203.0.113.9",
      }),
    ).toBe("203.0.113.9");
    expect(
      key({ "x-real-ip": "198.51.100.1", "x-forwarded-for": "1.1.1.1" }),
    ).toBe("198.51.100.1");
    // A client may send any X-Forwarded-For; the proxy appends the address it saw.
    expect(key({ "x-forwarded-for": "forged-1, forged-2, 192.0.2.7" })).toBe(
      "192.0.2.7",
    );
    expect(key({})).toBe("unknown");
    expect(key({ "x-real-ip": "x".repeat(100) })).toHaveLength(64);
  });
});
