import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCpo, type MockCpo } from "@/lib/mock-cpo";
import { ocpiRequest, type ClientOptions } from "@/lib/ocpi/client";
import { OcpiUnauthorizedError } from "@/lib/ocpi/errors";
import {
  connectToCpo,
  HandshakeError,
  invitePeer,
  rotateCredentials,
  unregisterPeer,
} from "@/lib/ocpi/handshake";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { MemoryPeerStore } from "@/lib/ocpi/store";
import {
  authorizationHeader,
  decryptToken,
  hashToken,
} from "@/lib/ocpi/tokens";
import { DemoModeError } from "@/lib/server/demo";
import {
  emspHandler,
  inProcessNetwork,
  installNetwork,
  LIVE_ENV,
} from "./support/network";

const EMSP_VERSIONS = "https://emsp.example.test/ocpi/versions";
const EMSP_CREDENTIALS = "https://emsp.example.test/ocpi/2.2.1/credentials";

let store: MemoryPeerStore;
let cpo: MockCpo;
let cpo2: MockCpo;
let net: ReturnType<typeof inProcessNetwork>;
const saved = { ...process.env };
const sleep = vi.fn(async () => {});
const client: ClientOptions = { sleep };

beforeEach(() => {
  Object.assign(process.env, LIVE_ENV);
  delete process.env.DEMO_MODE;
  store = new MemoryPeerStore();
  setPeerStoreForTests(store);
  net = inProcessNetwork({
    "emsp.example.test": emspHandler,
    "mock-cpo.example.test": (r) => cpo.handle(r),
    "cpo-two.example.test": (r) => cpo2.handle(r),
  });
  cpo = createMockCpo({ transport: net.transport });
  cpo2 = createMockCpo({
    transport: net.transport,
    baseUrl: "https://cpo-two.example.test",
    party: { countryCode: "YY", partyId: "TWO" },
    name: "Second CPO",
  });
  installNetwork(net.transport);
  sleep.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setPeerStoreForTests(undefined);
  process.env = { ...saved };
});

/** The CPO calls one of our endpoints with `token`. */
const callEmsp = (token: string, url = EMSP_VERSIONS) =>
  ocpiRequest({ url, token }, { transport: net.transport, retries: 0 });

/** Every token value the store could leak, if it kept any. */
function expectNoTokenIn(value: unknown, tokens: string[]) {
  const text = JSON.stringify(value, (_k, v) =>
    v instanceof Map ? [...v.entries()] : v,
  );
  for (const t of tokens) expect(text).not.toContain(t);
}

async function connect(mock = cpo, label = "Mock CPO") {
  const tokenA = mock.issueTokenA();
  const peer = await connectToCpo(
    { label, versionsUrl: mock.urls.versions, tokenA },
    { store, client },
  );
  return { peer, tokenA };
}

async function invited(mock = cpo, label = "Mock CPO") {
  const invite = await invitePeer({ label }, { store });
  await mock.registerWith(invite.versionsUrl, invite.tokenA);
  return invite;
}

describe("we register at a CPO (outbound)", () => {
  it("reads its versions with Token A, POSTs Token B and stores Token C encrypted", async () => {
    const { peer, tokenA } = await connect();

    expect(peer).toMatchObject({
      status: "registered",
      direction: "outbound",
      version: "2.2.1",
      versionsUrl: cpo.urls.versions,
      roles: [{ role: "CPO", country_code: "ZZ", party_id: "MCK" }],
    });
    expect(peer.endpoints.map((e) => e.identifier)).toContain("locations");

    // The CPO holds our Token B and called our versions with it during the POST.
    const tokenB = cpo.state.emsp!.token;
    expect(await store.findToken(hashToken(tokenB))).toMatchObject({
      peerId: peer.id,
      scope: "full",
    });
    const cpoCalls = net.calls.filter((c) => c.url.startsWith(EMSP_VERSIONS));
    expect(cpoCalls).toHaveLength(1);

    // We keep the CPO's Token C, encrypted, and Token A is spent.
    const tokenC = decryptToken(peer.tokenCiphertext!, peer.id);
    expect(cpo.state.issued.has(tokenC)).toBe(true);
    expect(cpo.state.tokensA.size).toBe(0);
    expectNoTokenIn(store, [tokenA, tokenB, tokenC]);

    // Token A for the discovery and the POST, Token C after it; one correlation ID.
    const [versions, details, post, ...after] = cpo.state.requests;
    expect([versions, details, post].map((r) => r.token)).toEqual([
      tokenA,
      tokenA,
      tokenA,
    ]);
    expect(post).toMatchObject({
      method: "POST",
      path: "/ocpi/2.2.1/credentials",
    });
    expect(post.headers.authorization).toBe(authorizationHeader(tokenA));
    expect(after.map((r) => r.token)).toEqual([tokenC, tokenC]);
    const correlation = new Set(
      cpo.state.requests.map((r) => r.headers["x-correlation-id"]),
    );
    expect(correlation.size).toBe(1);
    const requestIds = new Set(
      cpo.state.requests.map((r) => r.headers["x-request-id"]),
    );
    expect(requestIds.size).toBe(cpo.state.requests.length);

    // The CPO's POST carried our credentials, as the EMSP role.
    expect(cpo.state.emsp!.credentials).toMatchObject({
      url: EMSP_VERSIONS,
      roles: [{ role: "EMSP", country_code: "NL", party_id: "ABC" }],
    });
    expect((await callEmsp(tokenB)).statusCode).toBe(1000);
    expect(store.auditLog.map((a) => a.action)).toEqual([
      "ocpi.peer.registered",
    ]);
  });

  it("retries the discovery GETs on 5xx with backoff", async () => {
    cpo.failNext(2, 503);
    const { peer } = await connect();
    expect(peer.status).toBe("registered");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("fails cleanly on a wrong Token A, creating no peer", async () => {
    await expect(
      connectToCpo(
        {
          label: "Mock CPO",
          versionsUrl: cpo.urls.versions,
          tokenA: "wrong-token",
        },
        { store, client },
      ),
    ).rejects.toThrow(/refused our token/);
    expect(await store.listPeers()).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("marks the peer failed and revokes Token B when the POST fails", async () => {
    const tokenA = cpo.issueTokenA();
    // Versions and details succeed; the POST answers 500 and is not retried.
    const handle = cpo.handle;
    const network = inProcessNetwork({
      "emsp.example.test": emspHandler,
      "mock-cpo.example.test": (r) =>
        r.method === "POST"
          ? Promise.resolve(
              Response.json(
                { status_code: 3000, timestamp: "2026-10-21T00:00:00Z" },
                { status: 500 },
              ),
            )
          : handle(r),
    });
    installNetwork(network.transport);
    await expect(
      connectToCpo(
        { label: "Mock CPO", versionsUrl: cpo.urls.versions, tokenA },
        { store, client },
      ),
    ).rejects.toBeInstanceOf(HandshakeError);
    const [peer] = await store.listPeers();
    expect(peer.status).toBe("failed");
    expect([...store.tokens.values()].every((t) => t.revokedAt)).toBe(true);
    expect(network.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("refuses a CPO that offers no OCPI 2.2.1", async () => {
    installNetwork(
      inProcessNetwork({
        "old-cpo.example.test": async () =>
          Response.json({
            data: [
              {
                version: "2.1.1",
                url: "https://old-cpo.example.test/ocpi/2.1.1",
              },
            ],
            status_code: 1000,
            timestamp: "2026-10-21T00:00:00Z",
          }),
      }).transport,
    );
    const err = await connectToCpo(
      {
        label: "Old",
        versionsUrl: "https://old-cpo.example.test/ocpi/versions",
        tokenA: "a",
      },
      { store, client },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(HandshakeError);
    expect(err).toMatchObject({ statusCode: 3002 });
    expect(err.message).toContain("2.1.1");
  });

  it("refuses non-https versions URLs before sending anything", async () => {
    await expect(
      connectToCpo(
        {
          label: "x",
          versionsUrl: "http://mock-cpo.example.test/ocpi/versions",
          tokenA: "a",
        },
        { store, client },
      ),
    ).rejects.toThrow(/https/);
    expect(net.calls).toEqual([]);
  });

  it("is refused in demo mode, before any request", async () => {
    process.env.DEMO_MODE = "true";
    const tokenA = cpo.issueTokenA();
    await expect(
      connectToCpo(
        { label: "Mock CPO", versionsUrl: cpo.urls.versions, tokenA },
        { store, client },
      ),
    ).rejects.toBeInstanceOf(DemoModeError);
    expect(net.calls).toEqual([]);
    expect(await store.listPeers()).toEqual([]);
  });
});

describe("a CPO registers with us (inbound)", () => {
  it("issues Token A, takes the CPO's Token B and answers with Token C", async () => {
    const {
      peer: invitedPeer,
      tokenA,
      versionsUrl,
    } = await invitePeer({ label: "Mock CPO" }, { store });
    expect(versionsUrl).toBe(EMSP_VERSIONS);
    expect(invitedPeer.status).toBe("pending");
    expect(await store.findToken(hashToken(tokenA))).toMatchObject({
      scope: "registration",
    });

    const ours = await cpo.registerWith(versionsUrl, tokenA);
    const tokenC = ours.token;
    expect(ours.roles).toEqual([
      expect.objectContaining({
        role: "EMSP",
        country_code: "NL",
        party_id: "ABC",
      }),
    ]);

    const peer = (await store.getPeer(invitedPeer.id))!;
    expect(peer).toMatchObject({
      status: "registered",
      direction: "inbound",
      versionsUrl: cpo.urls.versions,
      roles: [{ role: "CPO", country_code: "ZZ", party_id: "MCK" }],
    });
    // We call the CPO with its Token B, which we read its versions with.
    const tokenB = decryptToken(peer.tokenCiphertext!, peer.id);
    expect(cpo.state.issued.has(tokenB)).toBe(true);
    expect(
      cpo.state.requests.filter((r) => r.token === tokenB).map((r) => r.path),
    ).toEqual(["/ocpi/versions", "/ocpi/2.2.1"]);
    expectNoTokenIn(store, [tokenA, tokenB, tokenC]);

    // Token A is single-use; Token C works, but cannot register again.
    await expect(callEmsp(tokenA)).rejects.toBeInstanceOf(
      OcpiUnauthorizedError,
    );
    expect((await callEmsp(tokenC)).statusCode).toBe(1000);
    const again = await ocpiRequest(
      { method: "POST", url: EMSP_CREDENTIALS, token: tokenC, body: ours },
      { transport: net.transport },
    ).catch((e) => e);
    expect(again).toMatchObject({ httpStatus: 405 });
    expect(store.auditLog.map((a) => a.action)).toEqual([
      "ocpi.peer.invited",
      "ocpi.peer.registered",
    ]);
  });

  it("answers GET credentials with the caller's own token", async () => {
    const { tokenA } = await invitePeer({ label: "Mock CPO" }, { store });
    const res = await callEmsp(tokenA, EMSP_CREDENTIALS);
    expect(res.data).toMatchObject({ token: tokenA, url: EMSP_VERSIONS });
  });

  it("answers 3001 and stays pending when the CPO's versions cannot be read", async () => {
    const { peer, tokenA } = await invitePeer({ label: "Mock CPO" }, { store });
    const body = {
      token: "cpo-token-b",
      url: "https://unreachable.example.test/ocpi/versions",
      roles: [
        {
          role: "CPO",
          party_id: "UNR",
          country_code: "ZZ",
          business_details: { name: "Unreachable" },
        },
      ],
    };
    const err = await ocpiRequest(
      { method: "POST", url: EMSP_CREDENTIALS, token: tokenA, body },
      { transport: net.transport },
    ).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 3001, httpStatus: 400 });
    expect((await store.getPeer(peer.id))!.status).toBe("pending");
    expect((await callEmsp(tokenA)).statusCode).toBe(1000);
  });

  it("validates the credentials body against the 2.2.1 schema", async () => {
    const { tokenA } = await invitePeer({ label: "Mock CPO" }, { store });
    const err = await ocpiRequest(
      {
        method: "POST",
        url: EMSP_CREDENTIALS,
        token: tokenA,
        body: {
          token: "x".repeat(65),
          url: "http://cpo.example.test",
          roles: [],
        },
      },
      { transport: net.transport },
    ).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 2001, httpStatus: 400 });
    expect(err.message).toMatch(/credentials\.token/);
  });

  it("refuses PUT and DELETE before registration", async () => {
    const { tokenA } = await invitePeer({ label: "Mock CPO" }, { store });
    for (const method of ["PUT", "DELETE"] as const) {
      const err = await ocpiRequest(
        { method, url: EMSP_CREDENTIALS, token: tokenA, body: {} },
        { transport: net.transport },
      ).catch((e) => e);
      expect(err).toMatchObject({ httpStatus: 405 });
    }
  });

  it("lets the CPO rotate its tokens with PUT", async () => {
    const { peer } = await invited();
    const oldC = cpo.state.emsp!.token;
    const updated = await cpo.updateCredentials();
    expect(updated.token).not.toBe(oldC);

    await expect(callEmsp(oldC)).rejects.toBeInstanceOf(OcpiUnauthorizedError);
    expect((await callEmsp(updated.token)).statusCode).toBe(1000);
    const stored = (await store.getPeer(peer.id))!;
    expect(
      cpo.state.issued.has(decryptToken(stored.tokenCiphertext!, peer.id)),
    ).toBe(true);
    expect([...store.tokens.values()].filter((t) => !t.revokedAt)).toHaveLength(
      1,
    );
  });

  it("lets the CPO unregister with DELETE", async () => {
    const { peer } = await invited();
    const tokenC = cpo.state.emsp!.token;
    await cpo.unregister();
    expect(await store.getPeer(peer.id)).toMatchObject({
      status: "unregistered",
      tokenCiphertext: null,
    });
    await expect(callEmsp(tokenC)).rejects.toBeInstanceOf(
      OcpiUnauthorizedError,
    );
  });
});

describe("tokens we rotate, and unregistering from our side", () => {
  it("rotates with a CPO we registered at", async () => {
    const { peer } = await connect();
    const oldB = cpo.state.emsp!.token;
    const oldC = decryptToken(peer.tokenCiphertext!, peer.id);

    const rotated = await rotateCredentials(peer.id, { store, client });
    const newB = cpo.state.emsp!.token;
    const newC = decryptToken(rotated.tokenCiphertext!, peer.id);
    expect(newB).not.toBe(oldB);
    expect(newC).not.toBe(oldC);
    expect(cpo.state.issued.has(newC)).toBe(true);
    expect(cpo.state.issued.has(oldC)).toBe(false);
    await expect(callEmsp(oldB)).rejects.toBeInstanceOf(OcpiUnauthorizedError);
    expect((await callEmsp(newB)).statusCode).toBe(1000);
    // The PUT was authorised with the old Token C.
    const put = cpo.state.requests.find((r) => r.method === "PUT")!;
    expect(put.token).toBe(oldC);
  });

  it("rotates with a CPO that registered with us", async () => {
    const { peer } = await invited();
    const oldC = cpo.state.emsp!.token;
    await rotateCredentials(peer.id, { store, client });
    expect(cpo.state.emsp!.token).not.toBe(oldC);
    await expect(callEmsp(oldC)).rejects.toBeInstanceOf(OcpiUnauthorizedError);
    expect((await callEmsp(cpo.state.emsp!.token)).statusCode).toBe(1000);
  });

  it("keeps the old tokens when the CPO refuses the PUT", async () => {
    const { peer } = await connect();
    const oldB = cpo.state.emsp!.token;
    cpo.failNext(1, 500);
    await expect(
      rotateCredentials(peer.id, { store, client }),
    ).rejects.toBeInstanceOf(HandshakeError);
    expect((await callEmsp(oldB)).statusCode).toBe(1000);
    expect([...store.tokens.values()].filter((t) => !t.revokedAt)).toHaveLength(
      1,
    );
    const same = (await store.getPeer(peer.id))!;
    expect(same.tokenCiphertext).toBe(peer.tokenCiphertext);
  });

  it("unregisters at the CPO, then locally", async () => {
    const { peer } = await connect();
    const tokenB = cpo.state.emsp!.token;
    const done = await unregisterPeer(peer.id, { store, client });
    expect(done).toMatchObject({
      status: "unregistered",
      tokenCiphertext: null,
    });
    expect(cpo.state.emsp).toBeUndefined();
    await expect(callEmsp(tokenB)).rejects.toBeInstanceOf(
      OcpiUnauthorizedError,
    );
    await expect(rotateCredentials(peer.id, { store, client })).rejects.toThrow(
      /unregistered/,
    );
  });

  it("unregisters locally when the CPO already forgot us", async () => {
    const { peer } = await connect();
    cpo.state.issued.clear();
    const done = await unregisterPeer(peer.id, { store, client });
    expect(done.status).toBe("unregistered");
  });

  it("keeps the peer registered when the CPO cannot be reached", async () => {
    const { peer } = await connect();
    cpo.failNext(4, "hang");
    await expect(
      unregisterPeer(peer.id, { store, client: { ...client, timeoutMs: 5 } }),
    ).rejects.toThrow(/timed out/);
    expect((await store.getPeer(peer.id))!.status).toBe("registered");
  });

  it("closes an unused invitation", async () => {
    const { peer, tokenA } = await invitePeer({ label: "Mock CPO" }, { store });
    await unregisterPeer(peer.id, { store, client });
    await expect(callEmsp(tokenA)).rejects.toBeInstanceOf(
      OcpiUnauthorizedError,
    );
  });
});

describe("multiple CPO peers", () => {
  it("keeps each peer's roles, endpoints and tokens apart", async () => {
    const { peer: one } = await connect(cpo, "First");
    const { peer: two } = await invited(cpo2, "Second");
    expect((await store.listPeers()).map((p) => [p.label, p.status])).toEqual([
      ["First", "registered"],
      ["Second", "registered"],
    ]);
    expect(two.id).not.toBe(one.id);
    const tokenOne = cpo.state.emsp!.token;
    const tokenTwo = cpo2.state.emsp!.token;
    expect((await store.findToken(hashToken(tokenOne)))!.peerId).toBe(one.id);
    expect((await store.findToken(hashToken(tokenTwo)))!.peerId).toBe(two.id);

    // Unregistering one leaves the other working.
    await unregisterPeer(one.id, { store, client });
    await expect(callEmsp(tokenOne)).rejects.toBeInstanceOf(
      OcpiUnauthorizedError,
    );
    expect((await callEmsp(tokenTwo)).statusCode).toBe(1000);
  });

  it("refuses a second peer for a party that is already registered", async () => {
    await connect(cpo, "First");
    const clash = createMockCpo({
      transport: net.transport,
      baseUrl: "https://cpo-two.example.test",
      // Same party as the first mock CPO.
    });
    cpo2 = clash;
    const err = await connect(clash, "Clash").catch((e) => e);
    expect(err).toBeInstanceOf(HandshakeError);
    expect(err.message).toMatch(/ZZ-MCK is already registered/);
    // We told the second platform we are gone again.
    expect(clash.state.emsp).toBeUndefined();
    const peers = await store.listPeers();
    expect(peers.map((p) => p.status)).toEqual(["registered", "failed"]);
  });

  it("refuses an inbound registration for a party that is already registered", async () => {
    await connect(cpo, "First");
    const { tokenA } = await invitePeer({ label: "Clash" }, { store });
    const clash = createMockCpo({
      transport: net.transport,
      baseUrl: "https://cpo-two.example.test",
    });
    cpo2 = clash;
    const err = await clash.registerWith(EMSP_VERSIONS, tokenA).catch((e) => e);
    expect(err).toMatchObject({ httpStatus: 400, statusCode: 2000 });
  });
});
