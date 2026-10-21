import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { ocpiResponse, withOcpi } from "@/lib/ocpi/server";
import { MemoryPeerStore, type Peer } from "@/lib/ocpi/store";
import { hashToken } from "@/lib/ocpi/tokens";
import { LIVE_ENV } from "./support/network";

const saved = { ...process.env };
let store: MemoryPeerStore;
let peer: Peer;
const FULL = "full-token-value";
const TOKEN_A = "token-a-value";

const ROUTED = {
  "OCPI-from-country-code": "zz",
  "OCPI-from-party-id": "mck",
  "OCPI-to-country-code": "NL",
  "OCPI-to-party-id": "ABC",
};

const handler = vi.fn(
  async (ctx: Parameters<Parameters<typeof withOcpi>[0]>[0]) =>
    ocpiResponse({ peer: ctx.peer.id, from: ctx.from }, ctx),
);
const routed = withOcpi(handler, { access: "registered", routing: "required" });
const handshake = withOcpi(handler, { access: "handshake", routing: "none" });

const call = (
  route: (r: Request) => Promise<Response>,
  headers: Record<string, string> = {},
) => route(new Request("https://emsp.example.test/ocpi/2.2.1/x", { headers }));
const auth = (token: string, encode = true) => ({
  Authorization: `Token ${encode ? Buffer.from(token).toString("base64") : token}`,
});

beforeEach(async () => {
  Object.assign(process.env, LIVE_ENV);
  store = new MemoryPeerStore();
  setPeerStoreForTests(store);
  handler.mockClear();
  peer = await store.createPeer({ label: "CPO", direction: "outbound" });
  peer = (await store.updatePeer(peer.id, {
    status: "registered",
    registeredAt: new Date().toISOString(),
    roles: [
      {
        role: "CPO",
        country_code: "ZZ",
        party_id: "MCK",
        business_details: { name: "Mock" },
      },
    ],
  }))!;
  await store.issueToken({
    hash: hashToken(FULL),
    peerId: peer.id,
    scope: "full",
  });
  const pending = await store.createPeer({
    label: "Invited",
    direction: "inbound",
  });
  await store.issueToken({
    hash: hashToken(TOKEN_A),
    peerId: pending.id,
    scope: "registration",
  });
});

afterEach(() => {
  setPeerStoreForTests(undefined);
  process.env = { ...saved };
  vi.restoreAllMocks();
});

async function expectProblem(res: Response, http: number, code: number) {
  expect(res.status).toBe(http);
  expect(handler).not.toHaveBeenCalled();
  const body = await res.json();
  expect(body).toMatchObject({
    status_code: code,
    timestamp: expect.any(String),
  });
  expect(body.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  return body;
}

describe("OCPI server middleware", () => {
  it("rejects a missing, malformed or unknown token with 401", async () => {
    await expectProblem(await call(handshake), 401, 2000);
    await expectProblem(
      await call(handshake, { Authorization: "Bearer x" }),
      401,
      2000,
    );
    await expectProblem(await call(handshake, auth("unknown")), 401, 2000);
  });

  it("accepts the base64 token and the unencoded 2.1.1 form", async () => {
    expect((await call(handshake, auth(FULL))).status).toBe(200);
    expect((await call(handshake, auth(FULL, false))).status).toBe(200);
  });

  it("rejects tokens of unregistered or failed peers", async () => {
    await store.updatePeer(peer.id, { status: "unregistered" });
    await expectProblem(await call(handshake, auth(FULL)), 401, 2000);
    await store.updatePeer(peer.id, { status: "failed" });
    await expectProblem(await call(handshake, auth(FULL)), 401, 2000);
  });

  it("allows a Token A on handshake modules only", async () => {
    expect((await call(handshake, auth(TOKEN_A))).status).toBe(200);
    handler.mockClear();
    await expectProblem(
      await call(routed, { ...auth(TOKEN_A), ...ROUTED }),
      403,
      2000,
    );
  });

  it("requires routing headers that name this eMSP and the token's party", async () => {
    const res = await call(routed, { ...auth(FULL), ...ROUTED });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({
      peer: peer.id,
      from: { countryCode: "ZZ", partyId: "MCK" },
    });
    handler.mockClear();

    const without = { ...ROUTED } as Record<string, string>;
    delete without["OCPI-to-party-id"];
    await expectProblem(
      await call(routed, { ...auth(FULL), ...without }),
      400,
      2001,
    );
    await expectProblem(
      await call(routed, {
        ...auth(FULL),
        ...ROUTED,
        "OCPI-to-party-id": "XYZ",
      }),
      400,
      2001,
    );
    // A token cannot speak for another CPO's party.
    await expectProblem(
      await call(routed, {
        ...auth(FULL),
        ...ROUTED,
        "OCPI-from-party-id": "OTH",
      }),
      403,
      2000,
    );
  });

  it("echoes X-Request-ID and X-Correlation-ID, or generates them", async () => {
    const res = await call(handshake, {
      ...auth(FULL),
      "X-Request-ID": "req-1",
      "X-Correlation-ID": "corr-1",
    });
    expect(res.headers.get("x-request-id")).toBe("req-1");
    expect(res.headers.get("x-correlation-id")).toBe("corr-1");

    const failed = await call(handshake, { "X-Request-ID": "req-2" });
    expect(failed.headers.get("x-request-id")).toBe("req-2");
    expect(failed.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);

    const generated = await call(handshake, {
      ...auth(FULL),
      "X-Request-ID": " ",
    });
    expect(generated.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("answers 3000 on an unexpected error without leaking it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = withOcpi(
      async () => {
        throw new Error(`database said ${FULL}`);
      },
      { access: "handshake", routing: "none" },
    );
    const res = await call(broken, auth(FULL));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      status_code: 3000,
      status_message: "Internal server error",
    });
    expect(text).not.toContain(FULL);
    expect(log.mock.calls.flat().join(" ")).not.toContain(FULL);
  });
});
