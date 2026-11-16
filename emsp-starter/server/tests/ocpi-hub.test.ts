import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hubPartyAction,
  listPeersAction,
  syncPeerAction,
} from "@/app/admin/peers/actions";
import {
  CommandError,
  getCommand,
  startSession,
  stopSession,
  type CommandDeps,
} from "@/lib/commands/manage";
import { setPreAuthForTests } from "@/lib/commands/pre-auth";
import { setCommandStoreForTests } from "@/lib/commands/registry";
import { MemoryCommandStore } from "@/lib/commands/store";
import { setLocationStoreForTests } from "@/lib/locations/registry";
import { locationAppId } from "@/lib/locations/search";
import { MemoryLocationStore } from "@/lib/locations/store";
import { SyncError, syncAllPeers, syncPeer } from "@/lib/locations/sync";
import { createMockCpo, type MockCpo } from "@/lib/mock-cpo";
import { createMockHub, type MockHub } from "@/lib/mock-cpo/hub";
import { ocpiRequest, type ClientOptions } from "@/lib/ocpi/client";
import {
  connectToCpo,
  HandshakeError,
  invitePeer,
  rotateCredentials,
} from "@/lib/ocpi/handshake";
import { acceptParty, offerFromHub, removeParty } from "@/lib/ocpi/hub";
import {
  capOffered,
  cpoParties,
  isCpoParty,
  isPartyOfPeer,
  MAX_OFFERED,
  offerDeclaredParties,
  trustedParties,
} from "@/lib/ocpi/parties";
import { MAX_CREDENTIALS_ROLES, parseCredentials } from "@/lib/ocpi/schema";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import {
  MemoryPeerStore,
  type HubParty,
  type Peer,
  type PeerStore,
} from "@/lib/ocpi/store";
import { ocpiTimestamp, type Party } from "@/lib/ocpi/types";
import {
  pullAllSessions,
  pullSessions,
  type SessionPullDeps,
} from "@/lib/sessions/pull";
import { setSessionStoreForTests } from "@/lib/sessions/registry";
import { MemorySessionStore } from "@/lib/sessions/store";
import { createAppToken, blockToken } from "@/lib/tokens/manage";
import { retryPendingPushes } from "@/lib/tokens/push";
import { setTokenStoreForTests } from "@/lib/tokens/registry";
import { MemoryTokenStore } from "@/lib/tokens/store";
import {
  emspHandler,
  inProcessNetwork,
  installNetwork,
  LIVE_ENV,
  uninstallNetwork,
} from "./support/network";

/** Test fixtures only: any parties will do; none of this is built into the server. */
const A: Party = { countryCode: "ZZ", partyId: "AAA" };
const B: Party = { countryCode: "ZZ", partyId: "BBB" };
const EMSP = "https://emsp.example.test/ocpi/2.2.1";
const US: Party = { countryCode: "NL", partyId: "ABC" };
const T0 = new Date("2026-10-21T10:00:00Z");
const DRIVER = "driver-1";

let peers: MemoryPeerStore;
let tokens: MemoryTokenStore;
let locations: MemoryLocationStore;
let commands: MemoryCommandStore;
let sessions: MemorySessionStore;
let hub: MockHub;
let direct: MockCpo;
let net: ReturnType<typeof inProcessNetwork>;
let hubPeer: Peer;
const saved = { ...process.env };
const client: ClientOptions = { retries: 0, timeoutMs: 500 };

const cmdDeps = (over: Partial<CommandDeps> = {}): CommandDeps => ({
  commands,
  peers,
  tokens,
  locations,
  client,
  now: () => T0,
  ...over,
});
const pullDeps = (): SessionPullDeps => ({
  sessions,
  commands,
  tokens,
  peers,
  syncState: locations,
  client,
});
const syncDeps = () => ({ peers, locations, client });
const adminForm = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const accept = (party: Party) =>
  acceptParty(hubPeer.id, party, { store: peers });
const refreshHub = async () => (hubPeer = (await peers.getPeer(hubPeer.id))!);

beforeEach(async () => {
  Object.assign(process.env, LIVE_ENV);
  delete process.env.DEMO_MODE;
  delete process.env.ADMIN_SECRET;
  peers = new MemoryPeerStore();
  tokens = new MemoryTokenStore(peers);
  locations = new MemoryLocationStore();
  commands = new MemoryCommandStore();
  sessions = new MemorySessionStore();
  setPeerStoreForTests(peers);
  setTokenStoreForTests(tokens);
  setLocationStoreForTests(locations);
  setCommandStoreForTests(commands);
  setSessionStoreForTests(sessions);
  setPreAuthForTests({
    async hold() {
      return { ok: true, reference: null };
    },
    async release() {},
  });
  net = inProcessNetwork({
    "emsp.example.test": emspHandler,
    "mock-hub.example.test": (r) => hub.handle(r),
    "mock-cpo.example.test": (r) => direct.handle(r),
  });
  hub = createMockHub({
    transport: net.transport,
    parties: [{ party: A }, { party: B }],
  });
  direct = createMockCpo({ transport: net.transport });
  installNetwork(net.transport);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  hubPeer = await connectToCpo(
    {
      label: "Mock Hub",
      versionsUrl: hub.urls.versions,
      tokenA: hub.issueTokenA(),
    },
    { store: peers, client },
  );
  hub.connect();
});

afterEach(() => {
  uninstallNetwork();
  setPeerStoreForTests(undefined);
  setTokenStoreForTests(undefined);
  setLocationStoreForTests(undefined);
  setCommandStoreForTests(undefined);
  setSessionStoreForTests(undefined);
  setPreAuthForTests(undefined);
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const hubRequests = (p: Party) =>
  hub.cpo(p).state.requests.filter((r) => r.path.startsWith("/ocpi/2.2.1/"));

/** A raw push as `from`, with the hub's token (or another). */
const rawPush = (
  from: Party,
  path: string,
  body: unknown,
  { method = "PUT", token = hub.state.emsp!.token } = {},
) =>
  ocpiRequest(
    {
      method: method as "PUT",
      url: `${EMSP}/${path}`,
      token,
      body,
      routing: { from, to: US },
    },
    { transport: net.transport, retries: 0 },
  );

describe("handshake with a roaming hub", () => {
  it("registers a peer with a HUB role, with no party trusted yet", async () => {
    expect(hubPeer).toMatchObject({
      status: "registered",
      roles: [{ role: "HUB", country_code: "ZZ", party_id: "HUB" }],
      hubParties: [],
    });
    expect(trustedParties(hubPeer)).toEqual([]);
    expect(cpoParties(hubPeer)).toEqual([]);
    expect(hubPeer.endpoints.map((e) => e.identifier)).toContain(
      "hubclientinfo",
    );
  });

  it("still refuses a peer with neither a CPO nor a HUB role", async () => {
    const other = createMockCpo({
      transport: net.transport,
      baseUrl: "https://mock-cpo.example.test",
      party: { countryCode: "ZZ", partyId: "NSP" },
      role: "NSP",
    });
    direct = other;
    await expect(
      connectToCpo(
        {
          label: "Navigation",
          versionsUrl: other.urls.versions,
          tokenA: other.issueTokenA(),
        },
        { store: peers, client },
      ),
    ).rejects.toThrow(/no CPO or HUB role/);
  });

  it("refuses a CPO that registers directly with a party another hub trusts", async () => {
    await accept(A);
    const same = createMockCpo({
      transport: net.transport,
      baseUrl: "https://mock-cpo.example.test",
      party: A,
    });
    direct = same;
    await expect(
      connectToCpo(
        {
          label: "Direct A",
          versionsUrl: same.urls.versions,
          tokenA: same.issueTokenA(),
        },
        { store: peers, client },
      ),
    ).rejects.toThrow(/already reached through a roaming hub/);
  });
});

/** A CPO role a hub declares in its own credentials. */
const cpoRole = (p: Party) => ({
  role: "CPO" as const,
  country_code: p.countryCode,
  party_id: p.partyId,
  business_details: { name: `Declared ${p.partyId}` },
});

/**
 * Every kind of push from `p` through the hub is refused (403, OCPI 2000): a location,
 * a session, a CDR, a command result, and a token authorization request.
 */
async function allRefusedFrom(p: Party) {
  const err = { httpStatus: 403, statusCode: 2000 };
  const cpo = hub.cpo(p);
  const { token } = await createAppToken(
    { driverRef: DRIVER },
    { tokens, peers, client, actor: "t" },
  );
  await expect(
    cpo.putLocation(cpo.state.locations[0], { push: true }),
  ).rejects.toMatchObject(err);
  await expect(
    cpo.push("sessions", "PUT", [p.countryCode, p.partyId, "S1"], {}),
  ).rejects.toMatchObject(err);
  await expect(
    rawPush(p, "cdrs", {}, { method: "POST" }),
  ).rejects.toMatchObject(err);
  await expect(
    rawPush(
      p,
      "commands/START_SESSION/00000000-0000-4000-8000-000000000000",
      { result: "ACCEPTED" },
      { method: "POST" },
    ),
  ).rejects.toMatchObject(err);
  await expect(
    cpo.authorize(token.uid, { type: "APP_USER" }),
  ).rejects.toMatchObject(err);
  expect(locations.locations.size).toBe(0);
  expect(sessions.sessions.size).toBe(0);
  expect(sessions.cdrs.size).toBe(0);
}

/** After the operator accepts `p`, its pushes go through. */
async function acceptedAfterAccepting(p: Party) {
  await acceptParty(hubPeer.id, p, { store: peers });
  await hub.cpo(p).putLocation(hub.cpo(p).state.locations[0], { push: true });
  expect(locations.locations.size).toBe(1);
}

describe("CPO roles a hub declares itself are offers, never trusted", () => {
  it("at registration: [HUB, CPO A] leaves A offered and refused until accepted", async () => {
    hub = createMockHub({
      transport: net.transport,
      party: { countryCode: "ZZ", partyId: "HB2" },
      parties: [{ party: A }, { party: B }],
    });
    hub.state.extraRoles.push(cpoRole(A));
    hubPeer = await connectToCpo(
      {
        label: "Declaring Hub",
        versionsUrl: hub.urls.versions,
        tokenA: hub.issueTokenA(),
      },
      { store: peers, client },
    );
    hub.connect();
    expect(hubPeer.roles.map((r) => r.role)).toEqual(["HUB", "CPO"]);
    expect(hubPeer.hubParties).toEqual([
      {
        ...A,
        status: "offered",
        source: "credentials",
        name: "Declared AAA",
      },
    ]);
    expect(trustedParties(hubPeer)).toEqual([]);
    expect(cpoParties(hubPeer)).toEqual([]);
    expect(isCpoParty(hubPeer, A)).toBe(false);
    expect(isPartyOfPeer(hubPeer, A)).toBe(false);
    await allRefusedFrom(A);
    await acceptedAfterAccepting(A);
    // Accepting keeps where the offer came from.
    expect((await refreshHub()).hubParties[0]).toMatchObject({
      status: "trusted",
      source: "credentials",
    });
  });

  it("at registration by the hub (credentials POST to us): the same", async () => {
    hub = createMockHub({
      transport: net.transport,
      party: { countryCode: "ZZ", partyId: "HB2" },
      parties: [{ party: A }, { party: B }],
    });
    hub.state.extraRoles.push(cpoRole(A));
    const invited = await invitePeer(
      { label: "Inbound Hub" },
      { store: peers, client },
    );
    await hub.registerWith(invited.versionsUrl, invited.tokenA);
    hub.connect();
    hubPeer = (await peers.getPeer(invited.peer.id))!;
    expect(hubPeer.status).toBe("registered");
    expect(hubPeer.hubParties).toMatchObject([
      { ...A, status: "offered", source: "credentials" },
    ]);
    await allRefusedFrom(A);
    await acceptedAfterAccepting(A);
  });

  it("at a credentials PUT from the hub that adds CPO A", async () => {
    hub.state.extraRoles.push(cpoRole(A));
    await hub.updateCredentials();
    hub.connect();
    await refreshHub();
    expect(hubPeer.roles.map((r) => r.role)).toEqual(["HUB", "CPO"]);
    expect(hubPeer.hubParties).toMatchObject([
      { ...A, status: "offered", source: "credentials" },
    ]);
    await allRefusedFrom(A);
    await acceptedAfterAccepting(A);
  });

  it("at a rotation we start, when the hub answers with CPO A", async () => {
    hub.state.extraRoles.push(cpoRole(A));
    hubPeer = await rotateCredentials(hubPeer.id, { store: peers, client });
    hub.connect();
    expect(hubPeer.roles.map((r) => r.role)).toEqual(["HUB", "CPO"]);
    expect(hubPeer.hubParties).toMatchObject([
      { ...A, status: "offered", source: "credentials" },
    ]);
    await allRefusedFrom(A);
    await acceptedAfterAccepting(A);
  });

  it("a declared role never undoes the operator's choice: a removed party stays out, a trusted one stays trusted", async () => {
    await accept(B);
    hub.state.extraRoles.push(cpoRole(A), cpoRole(B));
    await hub.updateCredentials();
    hub.connect();
    await refreshHub();
    expect(hubPeer.hubParties.map((h) => [h.partyId, h.status])).toEqual([
      ["BBB", "trusted"],
      ["AAA", "offered"],
    ]);
    await removeParty(hubPeer.id, B, { store: peers });
    await hub.updateCredentials();
    hub.connect();
    await refreshHub();
    expect(trustedParties(hubPeer)).toEqual([]);
    expect(hubPeer.hubParties.find((h) => h.partyId === "BBB")).toMatchObject({
      status: "offered",
    });
    await allRefusedFrom(B);
  });

  it("a hub cannot drop its HUB role to become a direct CPO, by PUT or by rotation", async () => {
    hub.state.role = "CPO";
    await expect(hub.updateCredentials()).rejects.toThrow(/HUB role/);
    expect((await refreshHub()).roles.map((r) => r.role)).toEqual(["HUB"]);
    await expect(
      rotateCredentials(hubPeer.id, { store: peers, client }),
    ).rejects.toThrow(/roles were refused/);
    expect((await refreshHub()).roles.map((r) => r.role)).toEqual(["HUB"]);
    expect(isCpoParty(hubPeer, hub.hubParty)).toBe(false);
  });

  it("a direct CPO cannot add a HUB role", async () => {
    const dp = await connectToCpo(
      {
        label: "Mock CPO",
        versionsUrl: direct.urls.versions,
        tokenA: direct.issueTokenA(),
      },
      { store: peers, client },
    );
    direct.state.role = "HUB";
    await expect(direct.updateCredentials()).rejects.toThrow(/HUB role/);
    expect((await peers.getPeer(dp.id))!.roles.map((r) => r.role)).toEqual([
      "CPO",
    ]);
  });

  it("another hub's declared CPO role does not stop a direct CPO or another hub's operator", async () => {
    hub.state.extraRoles.push(cpoRole(direct.party));
    await hub.updateCredentials();
    hub.connect();
    const dp = await connectToCpo(
      {
        label: "Mock CPO",
        versionsUrl: direct.urls.versions,
        tokenA: direct.issueTokenA(),
      },
      { store: peers, client },
    );
    expect(dp.status).toBe("registered");
    // And the hub cannot then be made to trust it.
    await expect(accept(direct.party)).rejects.toThrow(/already registered/);
  });
});

describe("trusted parties of a hub", () => {
  it("accepts a party by hand; nothing is built in", async () => {
    const peer = await accept({ countryCode: "zz", partyId: "aaa" });
    expect(peer.hubParties).toEqual([
      { ...A, status: "trusted", source: "admin" },
    ]);
    expect(trustedParties(peer)).toEqual([A]);
    expect(isCpoParty(peer, A)).toBe(true);
    expect(isCpoParty(peer, B)).toBe(false);
    expect(
      (await peers.listAudit(hubPeer.id, 5)).map((a) => a.action),
    ).toContain("ocpi.hub.party_trusted");
  });

  it("validates, and refuses our own party, another peer's party and another hub's", async () => {
    await expect(
      acceptParty(
        hubPeer.id,
        { countryCode: "Z", partyId: "AAA" },
        { store: peers },
      ),
    ).rejects.toThrow(/2 letters/);
    await expect(
      acceptParty(
        hubPeer.id,
        { countryCode: "ZZ", partyId: "AA" },
        { store: peers },
      ),
    ).rejects.toThrow(/3 letters/);
    await expect(accept(US)).rejects.toThrow(/own country code/);
    // A direct CPO peer's party.
    await connectToCpo(
      {
        label: "Mock CPO",
        versionsUrl: direct.urls.versions,
        tokenA: direct.issueTokenA(),
      },
      { store: peers, client },
    );
    await expect(accept(direct.party)).rejects.toThrow(/already registered as/);
    // Another hub's trusted party.
    const other = await peers.createPeer({
      label: "Hub 2",
      direction: "outbound",
    });
    await peers.updatePeer(other.id, {
      status: "registered",
      roles: [
        {
          role: "HUB",
          business_details: { name: "Hub 2" },
          country_code: "ZZ",
          party_id: "HB2",
        },
      ],
      hubParties: [{ ...B, status: "trusted", source: "admin" }],
      tokenCiphertext: "v1:x",
      registeredAt: new Date().toISOString(),
    });
    await expect(accept(B)).rejects.toThrow(/already trusted through Hub 2/);
  });

  it("is only for a registered hub", async () => {
    const dp = await connectToCpo(
      {
        label: "Mock CPO",
        versionsUrl: direct.urls.versions,
        tokenA: direct.issueTokenA(),
      },
      { store: peers, client },
    );
    await expect(
      acceptParty(dp.id, A, { store: peers }),
    ).rejects.toBeInstanceOf(HandshakeError);
    await expect(
      removeParty(dp.id, A, { store: peers }),
    ).rejects.toBeInstanceOf(HandshakeError);
  });

  it("offers the hub's client list without trusting it", async () => {
    const { peer, offered } = await offerFromHub(hubPeer.id, {
      store: peers,
      client,
    });
    expect(offered).toBe(2);
    expect(peer.hubParties.map((p) => [p.partyId, p.status, p.source])).toEqual(
      [
        ["AAA", "offered", "hubclientinfo"],
        ["BBB", "offered", "hubclientinfo"],
      ],
    );
    expect(trustedParties(peer)).toEqual([]);
    // The hub is asked with routing headers to its own role.
    expect(
      hub.state.requests.find((r) => r.path.endsWith("/hubclientinfo"))
        ?.headers,
    ).toMatchObject({
      "ocpi-from-party-id": "ABC",
      "ocpi-to-party-id": "HUB",
    });
  });

  it("keeps trusted parties on a refresh, adds only new offers, drops vanished ones, skips junk and our own party", async () => {
    await offerFromHub(hubPeer.id, { store: peers, client });
    await accept(A);
    hub.listed.splice(
      0,
      hub.listed.length,
      { party: A, status: "CONNECTED", role: "CPO" },
      { party: US, status: "CONNECTED", role: "CPO" },
      {
        party: { countryCode: "ZZ", partyId: "EMS" },
        status: "CONNECTED",
        role: "EMSP",
      },
      {
        party: { countryCode: "ZZ", partyId: "CCC" },
        status: "BOGUS",
        role: "CPO",
      },
      {
        party: { countryCode: "ZZ", partyId: "DDD" },
        status: "PLANNED",
        role: "CPO",
      },
    );
    const { peer, offered } = await offerFromHub(hubPeer.id, {
      store: peers,
      client,
    });
    expect(offered).toBe(1);
    expect(peer.hubParties.map((p) => [p.partyId, p.status])).toEqual([
      ["AAA", "trusted"],
      ["DDD", "offered"],
    ]);
  });

  it("accepting an offered party trusts it; removing it stops that and purges its cache", async () => {
    await offerFromHub(hubPeer.id, { store: peers, client });
    const peer = await accept(B);
    expect(peer.hubParties.find((p) => p.partyId === "BBB")).toMatchObject({
      status: "trusted",
      source: "hubclientinfo",
    });
    const purged: Party[] = [];
    const after = await removeParty(hubPeer.id, B, {
      store: peers,
      purge: async (_id, p) => void purged.push(p),
    });
    expect(trustedParties(after)).toEqual([]);
    expect(purged).toEqual([B]);
    await expect(removeParty(hubPeer.id, B, { store: peers })).rejects.toThrow(
      /not in the list/,
    );
  });

  it("a party removed while the hub's list is being read stays untrusted", async () => {
    await accept(A);
    await accept(B);
    // The hub is slow; the operator removes A while the list is on its way.
    const slow: ClientOptions = {
      ...client,
      async transport(url, init) {
        if (url.includes("/hubclientinfo"))
          await removeParty(hubPeer.id, A, { store: peers });
        return net.transport(url, init);
      },
    };
    const { peer } = await offerFromHub(hubPeer.id, {
      store: peers,
      client: slow,
    });
    expect(peer.hubParties.map((h) => [h.partyId, h.status])).toEqual([
      ["BBB", "trusted"],
      ["AAA", "offered"],
    ]);
    expect(isCpoParty(peer, A)).toBe(false);
    await expect(
      hub.cpo(A).putLocation(hub.cpo(A).state.locations[0], { push: true }),
    ).rejects.toMatchObject({ httpStatus: 403 });
  });

  it("a change between reading and writing the list is not lost (compare-and-set)", async () => {
    await accept(A);
    let once = true;
    const racy = Object.create(peers) as PeerStore;
    racy.updatePeer = async (...args) => {
      if (once) {
        once = false;
        // Someone else writes between our read and our write.
        await removeParty(hubPeer.id, A, { store: peers });
      }
      return peers.updatePeer(...args);
    };
    const { peer } = await offerFromHub(hubPeer.id, { store: racy, client });
    expect(trustedParties(peer)).toEqual([]);
    expect(peer.hubParties.find((h) => h.partyId === "AAA")).toMatchObject({
      status: "offered",
    });
  });

  it("a party accepted while the hub's list is being read stays trusted", async () => {
    const slow: ClientOptions = {
      ...client,
      async transport(url, init) {
        if (url.includes("/hubclientinfo")) await accept(A);
        return net.transport(url, init);
      },
    };
    const { peer } = await offerFromHub(hubPeer.id, {
      store: peers,
      client: slow,
    });
    expect(trustedParties(peer)).toEqual([A]);
  });

  it("works from the admin actions (accept, offer, remove, list)", async () => {
    process.env.ADMIN_SECRET = "s".repeat(32);
    const as = (f: Record<string, string>) =>
      adminForm({ adminSecret: "s".repeat(32), ...f });
    const offer = await hubPartyAction(
      {},
      as({ peerId: hubPeer.id, intent: "offer" }),
    );
    expect(offer).toMatchObject({ ok: true });
    const acc = await hubPartyAction(
      {},
      as({
        peerId: hubPeer.id,
        intent: "accept",
        countryCode: "zz",
        partyId: "aaa",
        name: "Party A",
      }),
    );
    expect(acc.ok).toBe(true);
    expect(acc.peer?.hub?.parties).toContainEqual({
      ...A,
      status: "trusted",
      source: "hubclientinfo",
      name: "Party A",
    });
    const list = await listPeersAction({}, as({}));
    const row = list.peers!.find((p) => p.id === hubPeer.id)!;
    expect(row.sync!.map((m) => m.module)).toContain("locations@ZZ-AAA");
    const rm = await hubPartyAction(
      {},
      as({
        peerId: hubPeer.id,
        intent: "remove",
        countryCode: "ZZ",
        partyId: "AAA",
      }),
    );
    expect(rm.ok).toBe(true);
    expect(
      (await peers.getPeer(hubPeer.id))!.hubParties.map((p) => p.partyId),
    ).toEqual(["BBB"]);
  });
});

describe("pulls through a hub", () => {
  it("need a trusted party, and ask that party by OCPI-to", async () => {
    await expect(syncPeer(hubPeer.id, "locations", syncDeps())).rejects.toThrow(
      /choose a trusted party/,
    );
    await expect(
      syncPeer(hubPeer.id, "locations", syncDeps(), { party: A }),
    ).rejects.toThrow(/not a trusted party/);
    expect(hubRequests(A)).toEqual([]);

    await accept(A);
    await refreshHub();
    const report = await syncPeer(hubPeer.id, "locations", syncDeps(), {
      party: A,
    });
    expect(report).toMatchObject({ complete: true, party: A, invalid: 0 });
    expect(report.items).toBeGreaterThan(0);
    for (const r of hubRequests(A))
      expect(r.headers).toMatchObject({
        "ocpi-from-country-code": "NL",
        "ocpi-from-party-id": "ABC",
        "ocpi-to-country-code": "ZZ",
        "ocpi-to-party-id": "AAA",
      });
    // The untrusted party was never asked.
    expect(hubRequests(B)).toEqual([]);
    expect(hub.unroutable).toEqual([]);
    const stored = [...locations.locations.values()];
    expect(
      stored.every(
        (s) => s.peerId === hubPeer.id && s.location.party_id === "AAA",
      ),
    ).toBe(true);
    // One state per party; a direct peer's key stays the plain module name.
    expect(
      await locations.getSyncState(hubPeer.id, "locations@ZZ-AAA"),
    ).toMatchObject({
      module: "locations@ZZ-AAA",
    });
    expect(await locations.getSyncState(hubPeer.id, "locations")).toBeNull();
  });

  it("skip objects of any other party than the one pulled", async () => {
    await accept(A);
    await accept(B);
    // A's Sender also serves one of B's locations.
    const foreign = hub.cpo(B).state.locations[0];
    hub.cpo(A).state.locations.push(structuredClone(foreign));
    const report = await syncPeer(hubPeer.id, "locations", syncDeps(), {
      party: A,
    });
    expect(report.invalid).toBe(1);
    expect(
      [...locations.locations.values()].every(
        (s) => s.location.party_id === "AAA",
      ),
    ).toBe(true);
  });

  it("keep each party's cursor, and a full pull prunes only its own party", async () => {
    await accept(A);
    await accept(B);
    await syncPeer(hubPeer.id, "locations", syncDeps(), { party: A });
    await syncPeer(hubPeer.id, "locations", syncDeps(), { party: B });
    const count = (party: string) =>
      [...locations.locations.values()].filter(
        (s) => s.location.party_id === party,
      ).length;
    const before = { a: count("AAA"), b: count("BBB") };
    expect(before.a).toBeGreaterThan(1);
    expect(before.b).toBeGreaterThan(0);
    // A drops a location; a full pull of A removes it and leaves B's alone.
    hub.cpo(A).state.locations.pop();
    const report = await syncPeer(hubPeer.id, "locations", syncDeps(), {
      party: A,
      mode: "full",
    });
    expect(report.removed).toBe(1);
    expect(count("AAA")).toBe(before.a - 1);
    expect(count("BBB")).toBe(before.b);
    expect(
      await locations.getSyncState(hubPeer.id, "locations@ZZ-BBB"),
    ).not.toBeNull();
  });

  it("a round pulls every trusted party and nothing else, for tariffs and locations", async () => {
    await accept(A);
    const out = await syncAllPeers(syncDeps());
    expect(out.map((o) => [o.module, o.party?.partyId, o.ok])).toEqual([
      ["tariffs", "AAA", true],
      ["locations", "AAA", true],
    ]);
    expect(hubRequests(B)).toEqual([]);
  });

  it("the admin pull goes through each trusted party, and says so with none", async () => {
    process.env.ADMIN_SECRET = "s".repeat(32);
    const f = adminForm({
      adminSecret: "s".repeat(32),
      peerId: hubPeer.id,
      intent: "full",
    });
    expect((await syncPeerAction({}, f)).message).toMatch(/no trusted party/);
    await accept(A);
    const done = await syncPeerAction({}, f);
    expect(done.ok).toBe(true);
    expect(done.message).toMatch(/of ZZ-AAA/);
  });

  it("sessions and CDRs of a trusted party are pulled; those of another party skipped", async () => {
    await accept(A);
    const recent = (m = 0) => ocpiTimestamp(new Date(Date.now() + m * 60_000));
    const uid = (
      await createAppToken(
        { driverRef: DRIVER },
        { tokens, peers, client, actor: "t" },
      )
    ).token.uid;
    const session = (party: Party, id: string) => ({
      country_code: party.countryCode,
      party_id: party.partyId,
      id,
      start_date_time: recent(1),
      end_date_time: recent(30),
      kwh: 3,
      cdr_token: {
        country_code: US.countryCode,
        party_id: US.partyId,
        uid,
        type: "APP_USER" as const,
        contract_id: "x",
      },
      auth_method: "WHITELIST" as const,
      location_id: "LOC1",
      evse_uid: "LOC1-1",
      connector_id: "1",
      currency: "EUR",
      status: "COMPLETED" as const,
      last_updated: recent(31),
    });
    await hub.cpo(A).putSession(session(A, "S1"));
    await hub.cpo(A).putSession(session(B, "S2"));
    const report = await pullSessions(hubPeer.id, "sessions", pullDeps(), {
      party: A,
    });
    expect(report).toMatchObject({ items: 1, invalid: 1, party: A });
    expect(
      await locations.getSyncState(hubPeer.id, "sessions@ZZ-AAA"),
    ).not.toBeNull();
    await expect(
      pullSessions(hubPeer.id, "sessions", pullDeps()),
    ).rejects.toBeInstanceOf(SyncError);
    const round = await pullAllSessions(pullDeps());
    expect(round.every((o) => o.party?.partyId === "AAA")).toBe(true);
  });
});

describe("token pushes through a hub", () => {
  const uidOf = async () => (await tokens.listByDriver(DRIVER))[0].uid;

  it("go only to trusted parties, one request each, addressed by OCPI-to", async () => {
    await accept(A);
    await createAppToken(
      { driverRef: DRIVER },
      { tokens, peers, client, actor: "t" },
    );
    const uid = await uidOf();
    expect(hub.cpo(A).pushedToken(uid, "APP_USER", US)).toBeTruthy();
    expect(hub.cpo(B).pushedToken(uid, "APP_USER", US)).toBeUndefined();
    const put = hub.cpo(A).state.requests.find((r) => r.method === "PUT")!;
    expect(put.headers).toMatchObject({
      "ocpi-to-party-id": "AAA",
      "ocpi-from-party-id": "ABC",
    });
    expect(hubRequests(B)).toEqual([]);

    // A second trusted party gets later changes too.
    await accept(B);
    await blockToken(uid, "APP_USER", {
      tokens,
      peers,
      client,
      actor: "t",
    }).catch(() => {});
    expect(
      hub
        .cpo(B)
        .state.requests.some((r) => r.method === "PATCH" || r.method === "PUT"),
    ).toBe(true);
  });

  it("do not go to a hub with no trusted party, and a retry drops them", async () => {
    await createAppToken(
      { driverRef: DRIVER },
      { tokens, peers, client, actor: "t" },
    );
    expect(hub.state.requests.some((r) => r.method === "PUT")).toBe(false);
    expect(hubRequests(A)).toEqual([]);
    expect(await retryPendingPushes({ tokens, peers, client })).toMatchObject({
      sent: 0,
    });
  });

  it("are pulled by a trusted party only", async () => {
    await accept(A);
    await createAppToken(
      { driverRef: DRIVER },
      { tokens, peers, client, actor: "t" },
    );
    expect((await hub.cpo(A).pullTokens()).length).toBe(1);
    await expect(hub.cpo(B).pullTokens()).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  it("token authorization is answered for a trusted party and refused for others", async () => {
    await accept(A);
    const { token } = await createAppToken(
      { driverRef: DRIVER },
      { tokens, peers, client, actor: "t" },
    );
    expect(
      (await hub.cpo(A).authorize(token.uid, { type: "APP_USER" })).allowed,
    ).toBeTruthy();
    await expect(
      hub.cpo(B).authorize(token.uid, { type: "APP_USER" }),
    ).rejects.toMatchObject({
      httpStatus: 403,
    });
  });
});

describe("pushes received through a hub", () => {
  it("are accepted from a trusted party, stored under the hub peer", async () => {
    await accept(A);
    const loc = hub.cpo(A).state.locations[0];
    await hub.cpo(A).putLocation(loc, { push: true });
    await hub.cpo(A).putTariff(hub.cpo(A).state.tariffs[0], { push: true });
    const stored = [...locations.locations.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ peerId: hubPeer.id });
    expect(locations.tariffs.size).toBe(1);
    // And patches and deletes of it.
    await hub
      .cpo(A)
      .setEvseStatus(loc.id, loc.evses![0].uid, "CHARGING", { push: true });
    await hub
      .cpo(A)
      .deleteTariff(hub.cpo(A).state.tariffs[0].id, { push: true });
    expect(locations.tariffs.size).toBe(0);
  });

  it("are refused from a party the hub offered but the operator has not accepted", async () => {
    await offerFromHub(hubPeer.id, { store: peers, client });
    await accept(A);
    const err = { httpStatus: 403, statusCode: 2000 };
    await expect(
      hub.cpo(B).putLocation(hub.cpo(B).state.locations[0], { push: true }),
    ).rejects.toMatchObject(err);
    await expect(
      hub.cpo(B).putTariff(hub.cpo(B).state.tariffs[0], { push: true }),
    ).rejects.toMatchObject(err);
    await expect(
      hub.cpo(B).push("sessions", "PUT", ["ZZ", "BBB", "S1"], {}),
    ).rejects.toMatchObject(err);
    await expect(
      rawPush(B, "cdrs", {}, { method: "POST" }),
    ).rejects.toMatchObject(err);
    await expect(
      rawPush(
        B,
        "commands/START_SESSION/00000000-0000-4000-8000-000000000000",
        { result: "ACCEPTED" },
        { method: "POST" },
      ),
    ).rejects.toMatchObject(err);
    expect(locations.locations.size).toBe(0);
    expect(locations.tariffs.size).toBe(0);
    expect(sessions.sessions.size).toBe(0);
    expect(sessions.cdrs.size).toBe(0);
  });

  it("are refused from a trusted party of a different peer, and from a trusted party under another's path", async () => {
    await accept(A);
    // A direct CPO peer, and a party the hub token does not stand for.
    const dp = await connectToCpo(
      {
        label: "Mock CPO",
        versionsUrl: direct.urls.versions,
        tokenA: direct.issueTokenA(),
      },
      { store: peers, client },
    );
    expect(dp.roles[0].role).toBe("CPO");
    const loc = direct.state.locations[0];
    // The direct CPO's party, sent with the hub's token.
    await expect(
      rawPush(direct.party, `locations/ZZ/MCK/${loc.id}`, loc),
    ).rejects.toMatchObject({ httpStatus: 403 });
    // The hub's token, a trusted party in OCPI-from but another party's objects in the path.
    await accept(B);
    const aLoc = hub.cpo(A).state.locations[0];
    await expect(
      rawPush(A, `locations/ZZ/BBB/${aLoc.id}`, { ...aLoc, party_id: "BBB" }),
    ).rejects.toMatchObject({ httpStatus: 403 });
    // And the direct peer's token with the hub's trusted party in OCPI-from.
    await expect(
      rawPush(A, `locations/ZZ/AAA/${aLoc.id}`, aLoc, {
        token: direct.state.emsp!.token,
      }),
    ).rejects.toMatchObject({ httpStatus: 403 });
    expect(locations.locations.size).toBe(0);
  });

  it("are refused as soon as the operator removes the party", async () => {
    await accept(A);
    await hub.cpo(A).putLocation(hub.cpo(A).state.locations[0], { push: true });
    await removeParty(hubPeer.id, A, { store: peers });
    await expect(
      hub.cpo(A).putLocation(hub.cpo(A).state.locations[1], { push: true }),
    ).rejects.toMatchObject({ httpStatus: 403 });
  });
});

describe("commands, sessions and CDRs through a hub", () => {
  const loc = (party: Party) =>
    locationAppId({
      peerId: hubPeer.id,
      countryCode: party.countryCode,
      partyId: party.partyId,
      id: "LOC1",
    });
  let n = 0;
  const begin = (party: Party, over = {}) =>
    startSession(
      {
        driverRef: DRIVER,
        requestId: `req-${String(++n).padStart(6, "0")}`,
        locationId: loc(party),
        evseUid: "LOC1-1",
        connectorId: "1",
        ...over,
      },
      cmdDeps(),
    );

  beforeEach(async () => {
    await accept(A);
    await accept(B);
    await syncPeer(hubPeer.id, "locations", syncDeps(), { party: A });
    await syncPeer(hubPeer.id, "locations", syncDeps(), { party: B });
    await createAppToken(
      { driverRef: DRIVER },
      { tokens, peers, client, actor: "t" },
    );
  });

  it("START_SESSION goes to the location's party by OCPI-to, and its result comes back from that party only", async () => {
    const { command } = await begin(A);
    expect(hub.cpo(B).state.commands).toEqual([]);
    const [sent] = hub.cpo(A).state.commands;
    expect(sent.headers).toMatchObject({
      "ocpi-to-country-code": "ZZ",
      "ocpi-to-party-id": "AAA",
      "ocpi-from-party-id": "ABC",
    });
    // Another trusted party cannot answer it: unknown command.
    await expect(
      hub.cpo(B).sendCommandResult("ACCEPTED", { command: sent }),
    ).rejects.toMatchObject({ httpStatus: 404 });
    await hub.cpo(A).sendCommandResult("ACCEPTED");
    expect(await getCommand(command.id, DRIVER, cmdDeps())).toMatchObject({
      status: "succeeded",
      result: "ACCEPTED",
    });
  });

  it("a command result from an untrusted party is refused", async () => {
    const { command } = await begin(A);
    await removeParty(hubPeer.id, B, { store: peers });
    await expect(
      hub.cpo(B).sendCommandResult("ACCEPTED", {
        command: hub.cpo(A).state.commands[0],
      }),
    ).rejects.toMatchObject({ httpStatus: 403 });
    // Still waiting for the real result: the refused one changed nothing.
    expect((await getCommand(command.id, DRIVER, cmdDeps()))!.pending).toBe(
      true,
    );
  });

  it("a command to a party that is no longer trusted is refused before anything is sent", async () => {
    await removeParty(hubPeer.id, A, { store: peers });
    await expect(begin(A)).rejects.toBeInstanceOf(CommandError);
    expect(hub.cpo(A).state.commands).toEqual([]);
    expect(hubRequests(A).filter((r) => r.path.includes("/commands/"))).toEqual(
      [],
    );
  });

  it("a session and its CDR, pushed by the party, are linked and STOP_SESSION goes to the same party", async () => {
    const { command } = await begin(A);
    await hub.cpo(A).sendCommandResult("ACCEPTED");
    const session = hub.cpo(A).sessionForCommand({ id: "SESSION-1", at: T0 });
    await hub.cpo(A).putSession(session, { push: true });
    const held = (await sessions.getSession({
      peerId: hubPeer.id,
      countryCode: "ZZ",
      partyId: "AAA",
      sessionId: "SESSION-1",
    }))!;
    expect(held).toMatchObject({ driverRef: DRIVER, commandId: command.id });

    const stop = await stopSession(
      {
        driverRef: DRIVER,
        requestId: `req-${String(++n).padStart(6, "0")}`,
        peerId: hubPeer.id,
        sessionId: "SESSION-1",
      },
      cmdDeps(),
    );
    expect(stop.command.status).toBe("accepted");
    expect(hub.cpo(A).state.commands.at(-1)).toMatchObject({
      type: "STOP_SESSION",
      body: { session_id: "SESSION-1" },
    });
    expect(hub.cpo(A).state.commands.at(-1)!.headers).toMatchObject({
      "ocpi-to-party-id": "AAA",
    });
    expect(hub.cpo(B).state.commands).toEqual([]);
    await hub.cpo(A).sendCommandResult("ACCEPTED");

    await hub.cpo(A).patchSession(
      "SESSION-1",
      {
        kwh: 5,
        status: "COMPLETED",
        end_date_time: ocpiTimestamp(new Date(T0.getTime() + 600_000)),
      },
      { push: true, at: new Date(T0.getTime() + 600_000) },
    );
    const cdr = hub.cpo(A).cdrFor("SESSION-1");
    await hub.cpo(A).postCdr(cdr, { push: true });
    expect(
      await sessions.getCdr({
        peerId: hubPeer.id,
        countryCode: "ZZ",
        partyId: "AAA",
        cdrId: cdr.id,
      }),
    ).toBeTruthy();
  });

  it("once the operator removes the party, its sessions, CDRs and command results are refused", async () => {
    const { command } = await begin(A);
    const sent = hub.cpo(A).state.commands[0];
    const session = hub.cpo(A).sessionForCommand({ id: "SESSION-1", at: T0 });
    await removeParty(hubPeer.id, A, { store: peers });
    const err = { httpStatus: 403, statusCode: 2000 };
    await expect(
      hub.cpo(A).sendCommandResult("ACCEPTED", { command: sent }),
    ).rejects.toMatchObject(err);
    await expect(
      hub.cpo(A).putSession(session, { push: true }),
    ).rejects.toMatchObject(err);
    await expect(
      rawPush(A, "cdrs", hub.cpo(A).cdrFor("SESSION-1"), { method: "POST" }),
    ).rejects.toMatchObject(err);
    expect(sessions.sessions.size).toBe(0);
    expect(sessions.cdrs.size).toBe(0);
    expect((await getCommand(command.id, DRIVER, cmdDeps()))!.pending).toBe(
      true,
    );
  });

  it("party B's session with party A's authorization_reference is not linked to A's start", async () => {
    const { command } = await begin(A);
    await hub.cpo(A).sendCommandResult("ACCEPTED");
    const aSession = hub.cpo(A).sessionForCommand({ id: "SESSION-1", at: T0 });
    // B's own session (its party, its path), carrying A's start reference.
    const bSession = {
      ...aSession,
      country_code: "ZZ",
      party_id: "BBB",
      id: "SESSION-B",
    };
    await rawPush(B, "sessions/ZZ/BBB/SESSION-B", bSession);
    const held = (await sessions.getSession({
      peerId: hubPeer.id,
      countryCode: "ZZ",
      partyId: "BBB",
      sessionId: "SESSION-B",
    }))!;
    expect(held.commandId).toBeNull();
    expect((await commands.get(command.id))!.sessionId).toBeFalsy();
    // A's own session still links to it.
    await hub.cpo(A).putSession(aSession, { push: true });
    expect(
      (await sessions.getSession({
        peerId: hubPeer.id,
        countryCode: "ZZ",
        partyId: "AAA",
        sessionId: "SESSION-1",
      }))!.commandId,
    ).toBe(command.id);
  });

  it("a session pushed in the name of the other trusted party is refused", async () => {
    await begin(A);
    await hub.cpo(A).sendCommandResult("ACCEPTED");
    const session = hub.cpo(A).sessionForCommand({ id: "SESSION-1", at: T0 });
    // Sent with party B's OCPI-from, but A's data.
    await expect(
      rawPush(B, "sessions/ZZ/AAA/SESSION-1", session),
    ).rejects.toMatchObject({ httpStatus: 403 });
    expect(sessions.sessions.size).toBe(0);
  });
});

describe("direct CPO peers behave as before", () => {
  let dp: Peer;
  beforeEach(async () => {
    dp = await connectToCpo(
      {
        label: "Mock CPO",
        versionsUrl: direct.urls.versions,
        tokenA: direct.issueTokenA(),
      },
      { store: peers, client },
    );
  });

  it("is its CPO roles; a hubParties list on a non-hub counts for nothing", async () => {
    expect(cpoParties(dp)).toEqual([direct.party]);
    const tricky = {
      ...dp,
      hubParties: [
        { ...A, status: "trusted" as const, source: "admin" as const },
      ],
    };
    expect(trustedParties(tricky)).toEqual([]);
    expect(isCpoParty(tricky, A)).toBe(false);
  });

  it("pulls without a party, addressed to its CPO role, with the plain state key", async () => {
    const report = await syncPeer(dp.id, "locations", syncDeps());
    expect(report.party).toBeUndefined();
    expect(report.items).toBeGreaterThan(0);
    expect(direct.state.requests.at(-1)!.headers).toMatchObject({
      "ocpi-to-party-id": "MCK",
    });
    expect(await locations.getSyncState(dp.id, "locations")).toMatchObject({
      module: "locations",
    });
    // An unneeded party is ignored.
    const ignored = await syncPeer(dp.id, "tariffs", syncDeps(), { party: A });
    expect(ignored.party).toBeUndefined();
    const out = await syncAllPeers(syncDeps());
    expect(
      out.filter((o) => o.peerId === dp.id).every((o) => o.party === undefined),
    ).toBe(true);
  });

  it("is sent tokens addressed to its CPO party and accepts pushes from it only", async () => {
    await createAppToken(
      { driverRef: DRIVER },
      { tokens, peers, client, actor: "t" },
    );
    const uid = (await tokens.listByDriver(DRIVER))[0].uid;
    expect(direct.pushedToken(uid, "APP_USER", US)).toBeTruthy();
    expect(
      direct.state.requests.find((r) => r.method === "PUT")!.headers,
    ).toMatchObject({
      "ocpi-to-party-id": "MCK",
    });
    await direct.putLocation(direct.state.locations[0], { push: true });
    expect(locations.locations.size).toBe(1);
    // A party it does not have is refused, trusted at a hub or not.
    await accept(A);
    await expect(
      rawPush(A, `locations/ZZ/AAA/X`, direct.state.locations[0], {
        token: direct.state.emsp!.token,
      }),
    ).rejects.toMatchObject({ httpStatus: 403 });
  });
});

const idN = (n: number): Party => ({
  countryCode: String.fromCharCode(65 + Math.floor(n / 676) + 0) + "Q",
  partyId: `${String.fromCharCode(65 + (Math.floor(n / 26) % 26))}${String.fromCharCode(65 + (n % 26))}X`,
});
const offered = (p: Party, source: HubParty["source"] = "credentials") =>
  ({ ...p, status: "offered", source }) satisfies HubParty;

describe("the offered parties of a hub are capped", () => {
  it("capOffered drops the oldest offered parties and never a trusted one", () => {
    const trusted = (p: Party) =>
      ({ ...p, status: "trusted", source: "admin" }) satisfies HubParty;
    const list: HubParty[] = [
      trusted(idN(0)),
      offered(idN(1)),
      offered(idN(2)),
      trusted(idN(3)),
      offered(idN(4)),
    ];
    expect(capOffered(list, 5)).toEqual(list);
    expect(capOffered(list, 2)).toEqual([
      trusted(idN(0)),
      offered(idN(2)),
      trusted(idN(3)),
      offered(idN(4)),
    ]);
    // Even a cap of 0 keeps what the operator trusts.
    expect(capOffered(list, 0).map((h) => h.status)).toEqual([
      "trusted",
      "trusted",
    ]);
  });

  it("declared roles past the cap push out the oldest offers, not trusted parties", () => {
    const list: HubParty[] = [
      { ...idN(0), status: "trusted", source: "admin" },
      ...Array.from({ length: MAX_OFFERED }, (_, i) => offered(idN(i + 1))),
    ];
    const roles = [idN(MAX_OFFERED + 1), idN(MAX_OFFERED + 2)].map(cpoRole);
    const next = offerDeclaredParties(list, roles);
    const of = next.filter((h) => h.status === "offered");
    expect(of).toHaveLength(MAX_OFFERED);
    expect(next[0]).toMatchObject({ ...idN(0), status: "trusted" });
    // The two oldest offers went; the two new ones are in.
    expect(of.some((h) => h.partyId === idN(1).partyId)).toBe(false);
    expect(of.some((h) => h.partyId === idN(2).partyId)).toBe(false);
    expect(of.at(-1)).toMatchObject(idN(MAX_OFFERED + 2));
    expect(of.at(-2)).toMatchObject(idN(MAX_OFFERED + 1));
  });

  it("repeated credentials PUTs cannot grow the list past the cap", async () => {
    // Seed the stored list at the cap, with one trusted party, then PUT more roles.
    const seed: HubParty[] = [
      { ...idN(0), status: "trusted", source: "admin" },
      ...Array.from({ length: MAX_OFFERED }, (_, i) => offered(idN(i + 1))),
    ];
    await peers.updatePeer(hubPeer.id, { hubParties: seed });
    for (let round = 0; round < 3; round++) {
      hub.state.extraRoles.length = 0;
      for (let i = 0; i < 20; i++)
        hub.state.extraRoles.push(cpoRole(idN(1000 + round * 20 + i)));
      await hub.updateCredentials();
      hub.connect();
    }
    await refreshHub();
    const of = hubPeer.hubParties.filter((h) => h.status === "offered");
    expect(of).toHaveLength(MAX_OFFERED);
    expect(hubPeer.hubParties.filter((h) => h.status === "trusted")).toEqual([
      { ...idN(0), status: "trusted", source: "admin" },
    ]);
    expect(of.at(-1)).toMatchObject(idN(1059));
  });

  it("a client list read keeps the cap and the trusted parties", async () => {
    const seed: HubParty[] = [
      { ...A, status: "trusted", source: "admin" },
      ...Array.from({ length: MAX_OFFERED }, (_, i) => offered(idN(i + 1))),
    ];
    await peers.updatePeer(hubPeer.id, { hubParties: seed });
    hub.listed.push(
      { party: B, status: "CONNECTED", role: "CPO" },
      { party: idN(9000), status: "CONNECTED", role: "CPO" },
    );
    const { peer } = await offerFromHub(hubPeer.id, { store: peers, client });
    expect(peer.hubParties.filter((h) => h.status === "offered")).toHaveLength(
      MAX_OFFERED,
    );
    expect(trustedParties(peer)).toEqual([A]);
    expect(peer.hubParties.some((h) => sameId(h, B))).toBe(true);
  });

  it("refuses credentials with more roles than the limit, as an OCPI client error", async () => {
    const role = (n: number) => ({
      ...cpoRole(idN(n)),
    });
    const body = (n: number) => ({
      token: "t".repeat(20),
      url: "https://mock-hub.example.test/ocpi/versions",
      roles: Array.from({ length: n }, (_, i) => role(i)),
    });
    expect(parseCredentials(body(MAX_CREDENTIALS_ROLES)).ok).toBe(true);
    expect(parseCredentials(body(MAX_CREDENTIALS_ROLES + 1)).ok).toBe(false);
    // The hub's own PUT with too many roles is refused and changes nothing.
    for (let i = 0; i < MAX_CREDENTIALS_ROLES; i++)
      hub.state.extraRoles.push(cpoRole(idN(i)));
    await expect(hub.updateCredentials()).rejects.toMatchObject({
      httpStatus: 400,
    });
    await refreshHub();
    expect(hubPeer.hubParties).toEqual([]);
  });
});

const sameId = (a: Party, b: Party) =>
  a.countryCode === b.countryCode && a.partyId === b.partyId;

describe("conflicts between peers cannot both pass at the same time", () => {
  const hub2Roles = [
    {
      role: "HUB" as const,
      business_details: { name: "Hub 2" },
      country_code: "ZZ",
      party_id: "HB2",
    },
  ];
  const secondHub = async () => {
    const other = await peers.createPeer({
      label: "Hub 2",
      direction: "outbound",
    });
    await peers.updatePeer(other.id, {
      status: "registered",
      roles: hub2Roles,
      tokenCiphertext: "v1:x",
      registeredAt: new Date().toISOString(),
    });
    return other;
  };
  /** A store that runs `during` once, when the first write of a hub's party list comes. */
  const racyOnParties = (during: () => Promise<unknown>) => {
    let once = true;
    const racy = Object.create(peers) as PeerStore;
    racy.updatePeer = async (id, patch, ...rest) => {
      if (once && patch.hubParties) {
        once = false;
        await during();
      }
      return peers.updatePeer(id, patch, ...rest);
    };
    return racy;
  };

  it("two hubs accepting one party: one stays, the other backs out", async () => {
    const other = await secondHub();
    const racy = racyOnParties(() =>
      acceptParty(other.id, B, { store: peers }),
    );
    await expect(acceptParty(hubPeer.id, B, { store: racy })).rejects.toThrow(
      /already trusted through Hub 2/,
    );
    expect(trustedParties((await peers.getPeer(other.id))!)).toEqual([B]);
    expect(trustedParties((await peers.getPeer(hubPeer.id))!)).toEqual([]);
  });

  it("backing out restores what the hub had offered", async () => {
    const other = await secondHub();
    await peers.updatePeer(hubPeer.id, {
      hubParties: [offered(B, "hubclientinfo")],
    });
    const racy = racyOnParties(() =>
      acceptParty(other.id, B, { store: peers }),
    );
    await expect(acceptParty(hubPeer.id, B, { store: racy })).rejects.toThrow();
    expect((await peers.getPeer(hubPeer.id))!.hubParties).toMatchObject([
      { ...B, status: "offered", source: "hubclientinfo" },
    ]);
  });

  it("a hub accepting a party while a direct CPO registers it: only one stays", async () => {
    const racy = racyOnParties(() =>
      connectToCpo(
        {
          label: "Mock CPO",
          versionsUrl: direct.urls.versions,
          tokenA: direct.issueTokenA(),
        },
        { store: peers, client },
      ),
    );
    await expect(
      acceptParty(hubPeer.id, direct.party, { store: racy }),
    ).rejects.toThrow(/already registered as/);
    expect(trustedParties((await peers.getPeer(hubPeer.id))!)).toEqual([]);
    const registered = (await peers.listPeers()).filter(
      (p) =>
        p.status === "registered" && !p.roles.some((r) => r.role === "HUB"),
    );
    expect(registered).toHaveLength(1);
  });

  it("a direct CPO registering a party a hub accepts meanwhile: the registration backs out", async () => {
    const racy = Object.create(peers) as PeerStore;
    let once = true;
    racy.updatePeer = async (id, patch, ...rest) => {
      if (once && patch.status === "registered" && !patch.hubParties) {
        once = false;
        await acceptParty(hubPeer.id, direct.party, { store: peers });
      }
      return peers.updatePeer(id, patch, ...rest);
    };
    await expect(
      connectToCpo(
        {
          label: "Mock CPO",
          versionsUrl: direct.urls.versions,
          tokenA: direct.issueTokenA(),
        },
        { store: racy, client },
      ),
    ).rejects.toThrow(/already reached through a roaming hub/);
    const cpo = (await peers.listPeers()).find((p) => p.label === "Mock CPO")!;
    expect(cpo.status).toBe("unregistered");
    expect(trustedParties((await peers.getPeer(hubPeer.id))!)).toEqual([
      direct.party,
    ]);
  });
});

describe("compare-and-set on the peer's version counter", () => {
  it("rev rises on every update, and a stale rev is refused even within one millisecond", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const p = await peers.createPeer({ label: "X", direction: "outbound" });
      expect(p.rev).toBe(0);
      const a = await peers.updatePeer(p.id, { label: "A" }, undefined, 0);
      expect(a?.rev).toBe(1);
      // Same millisecond, stale rev: refused. Current rev: accepted.
      expect(await peers.updatePeer(p.id, { label: "B" }, undefined, 0)).toBe(
        null,
      );
      expect((await peers.getPeer(p.id))!.label).toBe("A");
      expect(
        (await peers.updatePeer(p.id, { label: "B" }, undefined, 1))?.rev,
      ).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
