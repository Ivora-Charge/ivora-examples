import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCpo, type MockCpo } from "@/lib/mock-cpo";
import { ocpiRequest, type ClientOptions } from "@/lib/ocpi/client";
import { connectToCpo, invitePeer, unregisterPeer } from "@/lib/ocpi/handshake";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { MemoryPeerStore, type Peer } from "@/lib/ocpi/store";
import { parseToken } from "@/lib/ocpi/token-objects";
import { clientKey } from "@/lib/server/rate-limit";
import { decide } from "@/lib/tokens/authorize";
import { CONTRACT_ID, normalizeRfidUid } from "@/lib/tokens/contract-id";
import {
  addRfidCard,
  blockToken,
  createAppToken,
  expireTokens,
  nextLastUpdated,
  setWhitelist,
  TokenError,
  unblockToken,
  type TokenDeps,
} from "@/lib/tokens/manage";
import { pushToken, retryPendingPushes, toOcpiToken } from "@/lib/tokens/push";
import {
  DEMO_DRIVER_REF,
  setTokenStoreForTests,
  tokenStore,
} from "@/lib/tokens/registry";
import { MemoryTokenStore, pushBackoffMs } from "@/lib/tokens/store";
import {
  emspHandler,
  inProcessNetwork,
  installNetwork,
  LIVE_ENV,
  uninstallNetwork,
} from "./support/network";

const EMSP = "https://emsp.example.test/ocpi/2.2.1";
const T0 = new Date("2026-10-21T10:00:00Z");

let peers: MemoryPeerStore;
let tokens: MemoryTokenStore;
let cpo: MockCpo;
let cpo2: MockCpo;
let net: ReturnType<typeof inProcessNetwork>;
let clock: Date;
/** When set, runs before the first mock CPO handles a request: a test can hold it there. */
let hold: ((r: Request) => Promise<void>) | undefined;
const saved = { ...process.env };
const client: ClientOptions = { retries: 0 };

const deps = (): TokenDeps => ({
  tokens,
  peers,
  client,
  actor: "test",
  now: () => clock,
});

beforeEach(() => {
  Object.assign(process.env, LIVE_ENV);
  delete process.env.DEMO_MODE;
  peers = new MemoryPeerStore();
  tokens = new MemoryTokenStore(peers);
  setPeerStoreForTests(peers);
  setTokenStoreForTests(tokens);
  clock = T0;
  hold = undefined;
  net = inProcessNetwork({
    "emsp.example.test": emspHandler,
    "mock-cpo.example.test": async (r) => {
      await hold?.(r);
      return cpo.handle(r);
    },
    "cpo-two.example.test": (r) => cpo2.handle(r),
  });
  // Two CPOs on different platforms: we register at one, the other registers with us.
  cpo = createMockCpo({ transport: net.transport });
  cpo2 = createMockCpo({
    transport: net.transport,
    baseUrl: "https://cpo-two.example.test",
    party: { countryCode: "YY", partyId: "TWO" },
    name: "Second CPO",
  });
  installNetwork(net.transport);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  uninstallNetwork();
  setPeerStoreForTests(undefined);
  setTokenStoreForTests(undefined);
  process.env = { ...saved };
  vi.restoreAllMocks();
});

async function registerBoth(): Promise<[Peer, Peer]> {
  const one = await connectToCpo(
    {
      label: "Mock CPO",
      versionsUrl: cpo.urls.versions,
      tokenA: cpo.issueTokenA(),
    },
    { store: peers, client },
  );
  const invite = await invitePeer({ label: "Second CPO" }, { store: peers });
  await cpo2.registerWith(invite.versionsUrl, invite.tokenA);
  return [one, (await peers.getPeer(invite.peer.id))!];
}

const tokenRequests = (mock: MockCpo) =>
  mock.state.requests.filter((r) => r.path.startsWith("/ocpi/2.2.1/tokens/"));

describe("issuing tokens and pushing them to every CPO", () => {
  it("creates an app token with an eMA contract ID and PUTs it to both CPOs", async () => {
    await registerBoth();
    const { token, pushes } = await createAppToken(
      { driverRef: "driver-1", language: "NL" },
      deps(),
    );
    expect(token).toMatchObject({
      type: "APP_USER",
      countryCode: "NL",
      partyId: "ABC",
      driverRef: "driver-1",
      whitelist: "ALLOWED_OFFLINE",
      language: "nl",
      status: "active",
    });
    expect(token.contractId).toMatch(CONTRACT_ID);
    expect(token.contractId).toMatch(/^NLABCC[0-9A-HJ-NP-Z]{8}$/);
    expect(token.groupId).toBe(token.contractId);
    expect(token.uid).toMatch(/^[0-9A-F]{20}$/);
    expect(pushes.map((p) => p.ok)).toEqual([true, true]);

    const ocpi = toOcpiToken(token);
    expect(parseToken(ocpi)).toEqual({ ok: true, value: ocpi });
    for (const mock of [cpo, cpo2]) {
      expect(mock.pushedToken(token.uid, "APP_USER")).toEqual(ocpi);
      const [req] = tokenRequests(mock);
      expect(req.method).toBe("PUT");
      expect(req.path).toBe(`/ocpi/2.2.1/tokens/NL/ABC/${token.uid}`);
      expect(req.headers).toMatchObject({
        "ocpi-from-country-code": "NL",
        "ocpi-from-party-id": "ABC",
        "ocpi-to-country-code": mock.party.countryCode,
        "ocpi-to-party-id": mock.party.partyId,
      });
    }
    expect(peers.auditLog.at(-1)).toMatchObject({
      action: "token.create",
      subjectId: token.id,
    });
  });

  it("gives a driver one app token, and links RFID cards to its contract", async () => {
    await registerBoth();
    const app = (await createAppToken({ driverRef: "driver-1" }, deps())).token;
    await expect(
      createAppToken({ driverRef: "driver-1" }, deps()),
    ).rejects.toThrow("already has an app token");
    await expect(
      addRfidCard({ driverRef: "driver-2", uid: "04A1B2C3" }, deps()),
    ).rejects.toThrow("no app token yet");

    const { token: card } = await addRfidCard(
      {
        driverRef: "driver-1",
        uid: "04:a1:b2:c3:d4:e5:f6",
        visualNumber: "CARD-0001",
        whitelist: "ALLOWED_OFFLINE",
      },
      deps(),
    );
    expect(card).toMatchObject({
      type: "RFID",
      uid: "04A1B2C3D4E5F6",
      contractId: app.contractId,
      groupId: app.groupId,
      visualNumber: "CARD-0001",
      whitelist: "ALLOWED_OFFLINE",
    });
    expect(cpo2.pushedToken("04A1B2C3D4E5F6", "RFID")).toMatchObject({
      contract_id: app.contractId,
      visual_number: "CARD-0001",
      valid: true,
    });
    await expect(
      addRfidCard({ driverRef: "driver-1", uid: "04a1b2c3d4e5f6" }, deps()),
    ).rejects.toThrow("already registered");
    expect((await tokens.listByDriver("driver-1")).map((t) => t.type)).toEqual([
      "APP_USER",
      "RFID",
    ]);
  });

  it("refuses invalid input with a message that names no value", async () => {
    for (const [fn, message] of [
      [
        () => createAppToken({ driverRef: "has space" }, deps()),
        "Driver reference",
      ],
      [
        () =>
          createAppToken({ driverRef: "d", whitelist: "SOMETIMES" }, deps()),
        "Whitelist must be",
      ],
      [
        () => createAppToken({ driverRef: "d", language: "dutch" }, deps()),
        "Language",
      ],
      [() => addRfidCard({ driverRef: "d", uid: "!!" }, deps()), "Card UID"],
      [
        () =>
          addRfidCard(
            { driverRef: "d", uid: "04A1", expiresAt: "soon" },
            deps(),
          ),
        "Expiry",
      ],
    ] as const) {
      await expect(fn()).rejects.toThrow(TokenError);
      await expect(fn()).rejects.toThrow(message);
    }
    expect(normalizeRfidUid(" 04-a1 b2 ")).toBe("04A1B2");
  });

  it("blocks and unblocks with a PATCH to every CPO at once, last_updated always moving forward", async () => {
    await registerBoth();
    const app = (await createAppToken({ driverRef: "driver-1" }, deps())).token;
    const blocked = await blockToken(app.uid.toLowerCase(), "APP_USER", deps());
    expect(blocked.token.status).toBe("blocked");
    expect(blocked.pushes.every((p) => p.ok)).toBe(true);
    // Same clock: still a second later, so a CPO keeping the newest sees the change.
    expect(Date.parse(blocked.token.lastUpdated)).toBe(T0.getTime() + 1000);
    for (const mock of [cpo, cpo2]) {
      const patch = tokenRequests(mock).at(-1)!;
      expect(patch.method).toBe("PATCH");
      expect(mock.pushedToken(app.uid, "APP_USER")).toMatchObject({
        valid: false,
        last_updated: "2026-10-21T10:00:01Z",
      });
    }
    // Blocking again changes nothing and pushes nothing.
    expect((await blockToken(app.uid, "APP_USER", deps())).pushes).toEqual([]);

    const unblocked = await unblockToken(app.uid, "APP_USER", deps());
    expect(unblocked.token.status).toBe("active");
    expect(cpo.pushedToken(app.uid, "APP_USER")).toMatchObject({
      valid: true,
      last_updated: "2026-10-21T10:00:02Z",
    });

    await setWhitelist(app.uid, "APP_USER", "NEVER", deps());
    expect(cpo2.pushedToken(app.uid, "APP_USER")?.whitelist).toBe("NEVER");
    await expect(blockToken("NOPE", "RFID", deps())).rejects.toThrow(
      "No such token",
    );
    expect(
      peers.auditLog.map((e) => e.action).filter((a) => a.startsWith("token.")),
    ).toEqual([
      "token.create",
      "token.block",
      "token.unblock",
      "token.whitelist",
    ]);
  });

  it("queues a push a CPO missed and retries it with the current version", async () => {
    const [one, two] = await registerBoth();
    const app = (await createAppToken({ driverRef: "driver-1" }, deps())).token;
    cpo.failNext(1, 503);
    const { pushes } = await blockToken(app.uid, "APP_USER", deps());
    expect(pushes).toEqual([
      expect.objectContaining({ peerId: one.id, ok: false }),
      expect.objectContaining({ peerId: two.id, ok: true }),
    ]);
    expect(pushes[0].error).toMatch(/HTTP 503/);
    expect(pushes[0].error).not.toContain(app.uid.toLowerCase());
    expect(cpo.pushedToken(app.uid, "APP_USER")?.valid).toBe(true);
    expect(await tokens.countPendingPushes(10)).toBe(1);

    // Not due yet: nothing sent.
    expect(await retryPendingPushes(deps())).toEqual({
      sent: 0,
      failed: 0,
      dropped: 0,
    });
    clock = new Date(T0.getTime() + pushBackoffMs(1));
    cpo.failNext(1, 502);
    expect(await retryPendingPushes(deps())).toMatchObject({ failed: 1 });
    const [queued] = await tokens.duePushes("9999-01-01T00:00:00Z", 10);
    expect(queued.attempts).toBe(2);
    expect(Date.parse(queued.nextAttemptAt)).toBe(
      clock.getTime() + pushBackoffMs(2),
    );

    clock = new Date(queued.nextAttemptAt);
    expect(await retryPendingPushes(deps())).toMatchObject({ sent: 1 });
    expect(tokenRequests(cpo).at(-1)?.method).toBe("PUT");
    expect(cpo.pushedToken(app.uid, "APP_USER")?.valid).toBe(false);
    expect(await tokens.countPendingPushes(10)).toBe(0);
  });

  it("keeps a change owed in the outbox when the server fails before recording a failed push", async () => {
    await registerBoth();
    const app = (await createAppToken({ driverRef: "driver-1" }, deps())).token;
    expect(await tokens.countPendingPushes(10)).toBe(0);
    cpo.failNext(1, 503);
    vi.spyOn(tokens, "pushFailed").mockRejectedValueOnce(
      new Error("database down"),
    );
    await expect(blockToken(app.uid, "APP_USER", deps())).rejects.toThrow(
      "database down",
    );
    // The block is committed, and the outbox still owes it to the CPO that missed it.
    expect((await tokens.getToken(app.uid, "APP_USER"))?.status).toBe(
      "blocked",
    );
    expect(cpo.pushedToken(app.uid, "APP_USER")?.valid).toBe(true);
    const [owed] = await tokens.duePushes("9999-01-01T00:00:00Z", 10);
    expect(owed).toMatchObject({ attempts: 0, tokenId: app.id });
    // Blocking again changes nothing; the outbox delivers.
    expect((await blockToken(app.uid, "APP_USER", deps())).pushes).toEqual([]);
    clock = new Date(T0.getTime() + 61_000);
    expect(await retryPendingPushes(deps())).toMatchObject({ sent: 1 });
    expect(cpo.pushedToken(app.uid, "APP_USER")?.valid).toBe(false);
    expect(await tokens.countPendingPushes(10)).toBe(0);
  });

  it("owes a change written without any push (a server that stopped) to every CPO", async () => {
    await registerBoth();
    const app = (await createAppToken({ driverRef: "driver-1" }, deps())).token;
    await tokens.updateToken(
      app.id,
      { status: "blocked", lastUpdated: "2026-10-21T10:00:01.000Z" },
      app.revision,
    );
    expect(await tokens.countPendingPushes(10)).toBe(2);
    // Not before the first push's grace minute.
    expect(await retryPendingPushes(deps())).toMatchObject({ sent: 0 });
    clock = new Date(T0.getTime() + 61_000);
    expect(await retryPendingPushes(deps())).toMatchObject({ sent: 2 });
    for (const mock of [cpo, cpo2])
      expect(mock.pushedToken(app.uid, "APP_USER")?.valid).toBe(false);
    expect(await tokens.countPendingPushes(10)).toBe(0);
  });

  it("ends with valid: false at the CPO when a delayed unblock lands after a later block", async () => {
    await registerBoth();
    const app = (await createAppToken({ driverRef: "driver-1" }, deps())).token;
    await blockToken(app.uid, "APP_USER", deps());

    // Hold the unblock's PATCH on its way to the first CPO.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let arrived!: () => void;
    const atCpo = new Promise<void>((r) => (arrived = r));
    hold = async (r) => {
      if (r.method !== "PATCH") return;
      hold = undefined;
      arrived();
      await released;
    };
    clock = new Date(T0.getTime() + 10_000);
    const unblocking = unblockToken(app.uid, "APP_USER", deps());
    await atCpo;

    // Meanwhile the token is blocked again, and that push lands first.
    clock = new Date(T0.getTime() + 20_000);
    const blocked = await blockToken(app.uid, "APP_USER", deps());
    expect(blocked.pushes.every((p) => p.ok)).toBe(true);
    expect(cpo.pushedToken(app.uid, "APP_USER")?.valid).toBe(false);

    // The stale unblock lands now (valid: true), and is followed by the current version.
    release();
    const unblocked = await unblocking;
    expect(unblocked.pushes.every((p) => p.ok)).toBe(true);
    const last = tokenRequests(cpo).slice(-2);
    expect(last.map((r) => r.method)).toEqual(["PATCH", "PUT"]);
    expect(cpo.pushedToken(app.uid, "APP_USER")).toMatchObject({
      valid: false,
      last_updated: "2026-10-21T10:00:20Z",
    });
    expect(cpo2.pushedToken(app.uid, "APP_USER")?.valid).toBe(false);
    expect(await tokens.countPendingPushes(10)).toBe(0);
  });

  it("drops a queued push when the peer unregisters", async () => {
    const [one] = await registerBoth();
    const app = (await createAppToken({ driverRef: "driver-1" }, deps())).token;
    cpo.failNext(1, 500);
    await blockToken(app.uid, "APP_USER", deps());
    await unregisterPeer(one.id, { store: peers, client });
    clock = new Date(T0.getTime() + 3600_000);
    expect(await retryPendingPushes(deps())).toEqual({
      sent: 0,
      failed: 0,
      dropped: 1,
    });
    expect(await tokens.countPendingPushes(10)).toBe(0);
  });

  it("keeps a queued push when the token changed again after the push it retried", async () => {
    const t = (await createAppToken({ driverRef: "d" }, deps())).token;
    await tokens.pushFailed({
      peerId: "p",
      tokenId: t.id,
      tokenLastUpdated: "2026-10-21T10:00:05.000Z",
      error: "x",
      now: T0.toISOString(),
    });
    await tokens.pushSucceeded("p", t.id, "2026-10-21T10:00:04.000Z");
    expect(await tokens.countPendingPushes(10)).toBe(1);
    await tokens.pushSucceeded("p", t.id, "2026-10-21T10:00:05.000Z");
    expect(await tokens.countPendingPushes(10)).toBe(0);
  });

  it("marks tokens past their expiry as expired and pushes valid: false", async () => {
    await registerBoth();
    await createAppToken({ driverRef: "driver-1" }, deps());
    const { token: card } = await addRfidCard(
      { driverRef: "driver-1", uid: "0A0B0C0D", expiresAt: "2026-10-22" },
      deps(),
    );
    expect(await expireTokens(deps())).toBe(0);
    clock = new Date("2026-10-22T00:00:00Z");
    expect(await expireTokens(deps())).toBe(1);
    expect((await tokens.getToken(card.uid, "RFID"))?.status).toBe("expired");
    expect(cpo.pushedToken(card.uid, "RFID")?.valid).toBe(false);
    await expect(unblockToken(card.uid, "RFID", deps())).rejects.toThrow(
      "expired",
    );
  });

  it("nextLastUpdated is now in whole seconds, at least a second after the last", () => {
    expect(nextLastUpdated(null, new Date("2026-10-21T10:00:00.900Z"))).toBe(
      "2026-10-21T10:00:00.000Z",
    );
    expect(
      nextLastUpdated(
        "2026-10-21T10:00:30.000Z",
        new Date("2026-10-21T10:00:00Z"),
      ),
    ).toBe("2026-10-21T10:00:31.000Z");
  });
});

describe("Tokens Sender: CPOs pull our tokens", () => {
  async function issue(n: number) {
    for (let i = 0; i < n; i++) {
      clock = new Date(T0.getTime() + i * 60_000);
      await createAppToken({ driverRef: `driver-${i}` }, deps());
    }
  }

  it("lists the tokens endpoint in our version details", async () => {
    const [one] = await registerBoth();
    expect(one.endpoints.find((e) => e.identifier === "tokens")).toEqual({
      identifier: "tokens",
      role: "RECEIVER",
      url: cpo.urls.tokens,
    });
    const res = await ocpiRequest(
      { url: EMSP, token: cpo.state.emsp!.token },
      { transport: net.transport },
    );
    expect(res.data).toMatchObject({
      endpoints: expect.arrayContaining([
        { identifier: "tokens", role: "SENDER", url: `${EMSP}/tokens` },
      ]),
    });
  });

  it("serves every token, page by page, valid against 2.2.1, filtered by date_from and date_to", async () => {
    await registerBoth();
    await issue(5);
    const all = await cpo.pullTokens({ limit: 2 });
    expect(all).toHaveLength(5);
    expect(all.map((t) => t.last_updated)).toEqual(
      [...all.map((t) => t.last_updated)].sort(),
    );
    const pages = net.calls.filter(
      (c) => new URL(c.url).pathname === "/ocpi/2.2.1/tokens",
    );
    expect(pages).toHaveLength(3);

    const some = await cpo2.pullTokens({
      dateFrom: new Date(T0.getTime() + 60_000),
      dateTo: new Date(T0.getTime() + 180_000),
    });
    expect(some.map((t) => t.last_updated)).toEqual([
      "2026-10-21T10:01:00Z",
      "2026-10-21T10:02:00Z",
    ]);
  });

  it("answers with X-Total-Count, X-Limit and a Link on our public URL; refuses bad parameters", async () => {
    await registerBoth();
    await issue(3);
    const res = await ocpiRequest(
      {
        url: `${EMSP}/tokens`,
        token: cpo.state.emsp!.token,
        query: { limit: 500, offset: 1 },
        routing: {
          from: cpo.party,
          to: { countryCode: "NL", partyId: "ABC" },
        },
      },
      { transport: net.transport },
    );
    expect(res.headers.get("X-Total-Count")).toBe("3");
    expect(res.headers.get("X-Limit")).toBe("100");
    expect(res.headers.get("Link")).toBeNull();
    expect(res.data).toHaveLength(2);

    for (const query of [
      { date_from: "yesterday" },
      { limit: 0 },
      { offset: -1 },
    ])
      await expect(
        ocpiRequest(
          {
            url: `${EMSP}/tokens`,
            token: cpo.state.emsp!.token,
            query,
            routing: {
              from: cpo.party,
              to: { countryCode: "NL", partyId: "ABC" },
            },
          },
          { transport: net.transport, retries: 0 },
        ),
      ).rejects.toMatchObject({ statusCode: 2001, httpStatus: 400 });

    const first = await ocpiRequest(
      {
        url: `${EMSP}/tokens`,
        token: cpo.state.emsp!.token,
        query: { limit: 1, date_from: "2026-10-21T10:00:00Z" },
        routing: {
          from: cpo.party,
          to: { countryCode: "NL", partyId: "ABC" },
        },
      },
      { transport: net.transport },
    );
    const link = first.headers.get("Link")!;
    expect(link).toMatch(
      /^<https:\/\/emsp\.example\.test\/ocpi\/2\.2\.1\/tokens\?/,
    );
    expect(link).toContain("offset=1");
    expect(link).toContain("date_from=2026-10-21T10%3A00%3A00Z");
  });

  it("refuses unknown peers and requests without routing headers", async () => {
    await registerBoth();
    await expect(
      ocpiRequest(
        { url: `${EMSP}/tokens`, token: "not-a-token" },
        { transport: net.transport, retries: 0 },
      ),
    ).rejects.toMatchObject({ httpStatus: 401 });
    await expect(
      ocpiRequest(
        { url: `${EMSP}/tokens`, token: cpo.state.emsp!.token },
        { transport: net.transport, retries: 0 },
      ),
    ).rejects.toMatchObject({ httpStatus: 400, statusCode: 2001 });
  });
});

describe("routing headers and CPO parties at both tokens endpoints", () => {
  const OURS = { countryCode: "NL", partyId: "ABC" };

  async function setup() {
    const [one] = await registerBoth();
    const app = (await createAppToken({ driverRef: "driver-1" }, deps())).token;
    const call = (
      endpoint: "list" | "authorize",
      routing: {
        from: { countryCode: string; partyId: string };
        to: typeof OURS;
      },
    ) =>
      ocpiRequest(
        endpoint === "list"
          ? { url: `${EMSP}/tokens`, token: cpo.state.emsp!.token, routing }
          : {
              method: "POST",
              url: `${EMSP}/tokens/${app.uid}/authorize`,
              query: { type: "APP_USER" },
              token: cpo.state.emsp!.token,
              routing,
            },
        { transport: net.transport, retries: 0 },
      );
    return { one, call };
  }

  for (const endpoint of ["list", "authorize"] as const) {
    it(`${endpoint}: refuses an OCPI-from that is not the peer's party (2000, 403)`, async () => {
      const { call } = await setup();
      await expect(
        call(endpoint, {
          from: { countryCode: "YY", partyId: "TWO" },
          to: OURS,
        }),
      ).rejects.toMatchObject({ statusCode: 2000, httpStatus: 403 });
      // The right party works.
      await expect(
        call(endpoint, { from: cpo.party, to: OURS }),
      ).resolves.toMatchObject({ statusCode: 1000 });
    });

    it(`${endpoint}: refuses an OCPI-to that is not this eMSP (2001, 400)`, async () => {
      const { call } = await setup();
      await expect(
        call(endpoint, {
          from: cpo.party,
          to: { countryCode: "NL", partyId: "XYZ" },
        }),
      ).rejects.toMatchObject({ statusCode: 2001, httpStatus: 400 });
    });

    it(`${endpoint}: serves CPO parties only`, async () => {
      const { one, call } = await setup();
      const peer = peers.peers.get(one.id)!;
      peer.roles = peer.roles.map((r) => ({ ...r, role: "NSP" }));
      await expect(
        call(endpoint, { from: cpo.party, to: OURS }),
      ).rejects.toMatchObject({ statusCode: 2000, httpStatus: 403 });
    });
  }
});

describe("real-time authorization", () => {
  it("answers 3000 and never ALLOWED when the token store fails", async () => {
    await registerBoth();
    const app = (await createAppToken({ driverRef: "driver-1" }, deps())).token;
    vi.spyOn(tokens, "getToken").mockRejectedValue(new Error("database down"));
    const err = await cpo.authorize(app.uid, { type: "APP_USER" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ statusCode: 3000, httpStatus: 500 });
    expect(
      peers.auditLog.some(
        (e) =>
          e.action === "token.authorize" && e.details?.allowed === "ALLOWED",
      ),
    ).toBe(false);
  });

  it("allows an active token, with a reference and the location echoed", async () => {
    await registerBoth();
    await createAppToken({ driverRef: "driver-1" }, deps());
    const { token: card } = await addRfidCard(
      { driverRef: "driver-1", uid: "0A0B0C0D" },
      deps(),
    );
    // RFID is the default type.
    const info = await cpo.authorize("0a0b0c0d", {
      location: { location_id: "LOC1", evse_uids: ["LOC1-1"] },
    });
    expect(info).toMatchObject({
      allowed: "ALLOWED",
      token: { uid: card.uid, type: "RFID", valid: true },
      location: { location_id: "LOC1", evse_uids: ["LOC1-1"] },
    });
    expect(info.authorization_reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(info.info).toBeUndefined();
    expect(peers.auditLog.at(-1)).toMatchObject({
      action: "token.authorize",
      subjectId: card.id,
      details: {
        allowed: "ALLOWED",
        authorization_reference: info.authorization_reference,
        location_id: "LOC1",
      },
    });
    // Without a body.
    expect((await cpo2.authorize(card.uid)).allowed).toBe("ALLOWED");
  });

  it("answers BLOCKED for a blocked token, at once, and ALLOWED again once unblocked", async () => {
    await registerBoth();
    const app = (await createAppToken({ driverRef: "driver-1" }, deps())).token;
    await blockToken(app.uid, "APP_USER", deps());
    const blocked = await cpo.authorize(app.uid, { type: "APP_USER" });
    expect(blocked).toMatchObject({
      allowed: "BLOCKED",
      token: { valid: false },
      info: { language: "en", text: "This token is blocked." },
    });
    expect(blocked.authorization_reference).toBeUndefined();
    expect(blocked.location).toBeUndefined();
    await unblockToken(app.uid, "APP_USER", deps());
    expect((await cpo.authorize(app.uid, { type: "APP_USER" })).allowed).toBe(
      "ALLOWED",
    );
  });

  it("answers EXPIRED once a card is past its expiry, sweep or not", async () => {
    await registerBoth();
    await createAppToken({ driverRef: "driver-1" }, deps());
    await addRfidCard(
      { driverRef: "driver-1", uid: "0A0B0C0D", expiresAt: "2020-01-01" },
      deps(),
    );
    expect(await cpo.authorize("0A0B0C0D")).toMatchObject({
      allowed: "EXPIRED",
      token: { valid: false },
    });
  });

  it("answers 2004 for unknown tokens and types we do not issue, 2001 for a bad body or type", async () => {
    await registerBoth();
    const app = (await createAppToken({ driverRef: "driver-1" }, deps())).token;
    for (const [uid, type] of [
      ["UNKNOWN", "RFID"],
      [app.uid, "RFID"],
      [app.uid, "AD_HOC_USER"],
    ] as const)
      await expect(cpo.authorize(uid, { type })).rejects.toMatchObject({
        statusCode: 2004,
        httpStatus: 404,
      });
    await expect(
      cpo.authorize(app.uid, {
        type: "APP_USER",
        body: { evse_uids: ["x"] },
      }),
    ).rejects.toMatchObject({ statusCode: 2001, httpStatus: 400 });
    await expect(
      cpo.authorize(app.uid, { type: "BADGE" as never }),
    ).rejects.toMatchObject({ statusCode: 2001 });
  });

  it("refuses a peer that unregistered", async () => {
    const [one] = await registerBoth();
    const app = (await createAppToken({ driverRef: "driver-1" }, deps())).token;
    const token = cpo.state.emsp!.token;
    await unregisterPeer(one.id, { store: peers, client });
    await expect(
      ocpiRequest(
        {
          method: "POST",
          url: `${EMSP}/tokens/${app.uid}/authorize`,
          query: { type: "APP_USER" },
          token,
          routing: {
            from: cpo.party,
            to: { countryCode: "NL", partyId: "ABC" },
          },
        },
        { transport: net.transport, retries: 0 },
      ),
    ).rejects.toMatchObject({ httpStatus: 401 });
  });

  it("decides on the token first, then the driver's standing (part 7)", async () => {
    const t = (await createAppToken({ driverRef: "d" }, deps())).token;
    const now = new Date();
    expect(decide(t, now).allowed).toBe("ALLOWED");
    expect(decide(t, now, "no_credit")).toEqual({
      allowed: "NO_CREDIT",
      info: {
        language: "en",
        text: "No usable payment method on this account.",
      },
    });
    expect(decide(t, now, "not_allowed").allowed).toBe("NOT_ALLOWED");
    expect(decide(t, now, "blocked").allowed).toBe("BLOCKED");
    expect(decide({ ...t, status: "blocked" }, now, "no_credit").allowed).toBe(
      "BLOCKED",
    );
    expect(
      decide({ ...t, expiresAt: "2020-01-01T00:00:00Z" }, now, "no_credit")
        .allowed,
    ).toBe("EXPIRED");
  });
});

describe("demo mode", () => {
  it("serves the demo driver's tokens from memory and pushes nothing", async () => {
    setTokenStoreForTests(undefined);
    process.env.DEMO_MODE = "true";
    const fetchSpy = vi.fn(() => {
      throw new Error("demo mode must not call fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const store = tokenStore();
    const demo = await store.listByDriver(DEMO_DRIVER_REF);
    expect(demo.map((t) => [t.type, t.contractId])).toEqual([
      ["APP_USER", "ZZDMOCDEMO0001"],
      ["RFID", "ZZDMOCDEMO0001"],
    ]);
    expect(await pushToken(demo[0], { method: "PUT" }, deps())).toEqual([]);
    const { token, pushes } = await createAppToken(
      { driverRef: "demo-2" },
      { ...deps(), tokens: store },
    );
    // Forced demo mode keeps the configured identity.
    expect(token.contractId).toMatch(/^NLABCC/);
    expect(pushes).toEqual([]);
    expect(await retryPendingPushes(deps())).toEqual({
      sent: 0,
      failed: 0,
      dropped: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("rate-limit client key", () => {
  it("reads only TRUSTED_PROXY_HEADER when it is set, its last entry", () => {
    const h = new Headers({
      "x-real-ip": "198.51.100.1",
      "x-forwarded-for": "forged, 192.0.2.7",
      "cf-connecting-ip": "203.0.113.5",
    });
    // Without a trusted source, x-real-ip and x-forwarded-for are not read.
    expect(clientKey(h, {})).toBe("unknown");
    expect(clientKey(h, { VERCEL: "1" })).toBe("unknown");
    expect(clientKey(h, { TRUSTED_PROXY_HEADER: "CF-Connecting-IP" })).toBe(
      "203.0.113.5",
    );
    expect(clientKey(h, { TRUSTED_PROXY_HEADER: "x-forwarded-for" })).toBe(
      "192.0.2.7",
    );
    // A request without the trusted header shares the "unknown" key; nothing else is read.
    expect(clientKey(h, { TRUSTED_PROXY_HEADER: "x-client-ip" })).toBe(
      "unknown",
    );
  });
});
