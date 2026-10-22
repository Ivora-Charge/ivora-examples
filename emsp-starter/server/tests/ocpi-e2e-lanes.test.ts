import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { invitePeer } from "@/lib/ocpi/handshake";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { setPeerNetworkForTests } from "@/lib/server/peer-fetch";
import { MemoryPeerStore } from "@/lib/ocpi/store";
import { listen, type Inbound } from "./e2e/harness";
import { laneFromEnv, REAL_REQUIRED } from "./e2e/lanes";
import { LIVE_ENV } from "./support/network";

// The OCPI e2e suite's own guards (tests/e2e): which lane runs, and that a real CPO
// is never used from public CI or with a live Stripe key. The suite itself runs with
// `npm run test:ocpi-e2e`.

const REAL = {
  OCPI_E2E_VERSIONS_URL: "https://cpo.example.test/ocpi/versions",
  OCPI_E2E_TOKEN_A: "fake-token-a",
  OCPI_E2E_PUBLIC_URL: "https://emsp-e2e.example.test",
  EMSP_COUNTRY_CODE: "NL",
  EMSP_PARTY_ID: "ABC",
  STRIPE_SECRET_KEY: "sk_test_fake0123456789",
};
const VARS = [
  ...Object.keys(REAL),
  "CI",
  "GITHUB_ACTIONS",
  "OCPI_E2E_ALLOW_CI",
  "OCPI_E2E_EXPECT_START",
  "OCPI_E2E_LISTEN_PORT",
  "OCPI_E2E_TIMEOUT_SECONDS",
];

describe("OCPI e2e lanes", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const k of VARS) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("runs the mock CPO, both scenarios, without OCPI_E2E_VERSIONS_URL", () => {
    expect(laneFromEnv()).toEqual({
      kind: "mock",
      scenarios: ["accepted", "rejected"],
    });
    // In CI too: that is what public CI runs.
    process.env.CI = "true";
    expect(laneFromEnv().kind).toBe("mock");
  });

  it("runs a real CPO only with every variable, expecting a rejected start by default", () => {
    Object.assign(process.env, REAL);
    const lane = laneFromEnv();
    expect(lane).toMatchObject({
      kind: "real",
      scenarios: ["rejected"],
      settings: {
        publicUrl: "https://emsp-e2e.example.test",
        listenPort: 3318,
        expectStart: "rejected",
        waitMs: 300_000,
        chargeMs: 60_000,
      },
    });
    process.env.OCPI_E2E_EXPECT_START = "Accepted";
    expect(laneFromEnv().scenarios).toEqual(["accepted"]);
    process.env.OCPI_E2E_EXPECT_START = "maybe";
    expect(() => laneFromEnv()).toThrow(/accepted or rejected/);
  });

  it("names every missing variable, never a value", () => {
    process.env.OCPI_E2E_VERSIONS_URL = REAL.OCPI_E2E_VERSIONS_URL;
    let message = "";
    try {
      laneFromEnv();
    } catch (e) {
      message = (e as Error).message;
    }
    for (const name of REAL_REQUIRED.filter(
      (n) => n !== "OCPI_E2E_VERSIONS_URL",
    ))
      expect(message).toContain(name);
    expect(message).not.toContain("cpo.example.test");
  });

  it("refuses a real CPO in CI unless explicitly allowed", () => {
    Object.assign(process.env, REAL, { GITHUB_ACTIONS: "true" });
    expect(() => laneFromEnv()).toThrow(/in CI/);
    process.env.OCPI_E2E_ALLOW_CI = "1";
    expect(laneFromEnv().kind).toBe("real");
  });

  it("refuses a live Stripe key and a public URL that is not an https:// origin", () => {
    Object.assign(process.env, REAL);
    for (const key of ["sk_live_abc0123456789", "rk_live_abc0123456789"]) {
      process.env.STRIPE_SECRET_KEY = key;
      expect(() => laneFromEnv()).toThrow(/test-mode key/);
    }
    process.env.STRIPE_SECRET_KEY = REAL.STRIPE_SECRET_KEY;
    for (const url of [
      "http://emsp-e2e.example.test",
      "https://emsp-e2e.example.test/base",
      "not a url",
    ]) {
      process.env.OCPI_E2E_PUBLIC_URL = url;
      expect(() => laneFromEnv()).toThrow(/OCPI_E2E_PUBLIC_URL/);
    }
    process.env.OCPI_E2E_PUBLIC_URL = REAL.OCPI_E2E_PUBLIC_URL;
    process.env.OCPI_E2E_TIMEOUT_SECONDS = "soon";
    expect(() => laneFromEnv()).toThrow(/OCPI_E2E_TIMEOUT_SECONDS/);
  });
});

describe("the real lane's OCPI server", () => {
  const saved = { ...process.env };
  afterEach(() => {
    setPeerStoreForTests(undefined);
    setPeerNetworkForTests(undefined);
    process.env = { ...saved };
  });

  it("serves our OCPI routes on loopback and records method, path and status only", async () => {
    Object.assign(process.env, LIVE_ENV);
    const store = new MemoryPeerStore();
    setPeerStoreForTests(store);
    // The CPO's versions are never fetched: no DNS, no network.
    setPeerNetworkForTests({
      resolve: async () => {
        throw new Error("no network in tests");
      },
    });
    const inbound: Inbound[] = [];
    const server = await listen(0, LIVE_ENV.PUBLIC_BASE_URL, inbound);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/ocpi/versions`, {
        headers: { Authorization: "Token bm90LWEtdG9rZW4=" },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { status_code: number };
      expect(body.status_code).toBe(2000);

      // A body reaches the route: a CPO registering with a Token A gets as far as
      // reading its versions (refused here: 3001), not "invalid body" (2001).
      const { tokenA } = await invitePeer({ label: "CPO" }, { store });
      const post = await fetch(
        `http://127.0.0.1:${port}/ocpi/2.2.1/credentials`,
        {
          method: "POST",
          headers: {
            Authorization: `Token ${Buffer.from(tokenA).toString("base64")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            token: "cpo-token-b",
            url: "https://cpo.example.test/ocpi/versions",
            roles: [
              {
                role: "CPO",
                business_details: { name: "CPO" },
                party_id: "CPX",
                country_code: "ZZ",
              },
            ],
          }),
        },
      );
      expect(((await post.json()) as { status_code: number }).status_code).toBe(
        3001,
      );
      expect(inbound).toEqual([
        { method: "GET", path: "/ocpi/versions", status: 401 },
        {
          method: "POST",
          path: "/ocpi/2.2.1/credentials",
          status: post.status,
        },
      ]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
