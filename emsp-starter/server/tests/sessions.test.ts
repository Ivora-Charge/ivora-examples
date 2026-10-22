import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startSession,
  stopSession,
  type CommandDeps,
} from "@/lib/commands/manage";
import { setPreAuthForTests } from "@/lib/commands/pre-auth";
import { setCommandStoreForTests } from "@/lib/commands/registry";
import { MemoryCommandStore } from "@/lib/commands/store";
import {
  DEMO_PEER_ID,
  setLocationStoreForTests,
} from "@/lib/locations/registry";
import { locationAppId } from "@/lib/locations/search";
import { MemoryLocationStore } from "@/lib/locations/store";
import { createMockCpo, type MockCpo } from "@/lib/mock-cpo";
import { sampleCdrToken } from "@/lib/mock-cpo/sample-data";
import { ocpiRequest, type ClientOptions } from "@/lib/ocpi/client";
import { connectToCpo, invitePeer } from "@/lib/ocpi/handshake";
import { ocpiTimestamp } from "@/lib/ocpi/types";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import type { Session } from "@/lib/ocpi/session-objects";
import { MemoryPeerStore, type Peer } from "@/lib/ocpi/store";
import { onSessionEvent, type SessionEvent } from "@/lib/sessions/events";
import { sessionOwner } from "@/lib/sessions/owner";
import {
  pullAllSessions,
  pullSessions,
  type SessionPullDeps,
} from "@/lib/sessions/pull";
import { recordCdr, recordSession } from "@/lib/sessions/record";
import { reconcile } from "@/lib/sessions/reconcile";
import { sessionStore, setSessionStoreForTests } from "@/lib/sessions/registry";
import { MemorySessionStore } from "@/lib/sessions/store";
import { createAppToken } from "@/lib/tokens/manage";
import { setTokenStoreForTests } from "@/lib/tokens/registry";
import { MemoryTokenStore } from "@/lib/tokens/store";
import {
  emspHandler,
  inProcessNetwork,
  installNetwork,
  LIVE_ENV,
  uninstallNetwork,
} from "./support/network";

const EMSP = "https://emsp.example.test/ocpi/2.2.1";
const T0 = new Date("2026-10-21T10:00:00Z");
const DRIVER = "driver-1";
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const iso = (minutes: number) => at(minutes).toISOString().replace(".000", "");

let peers: MemoryPeerStore;
let tokens: MemoryTokenStore;
let locations: MemoryLocationStore;
let commands: MemoryCommandStore;
let sessions: MemorySessionStore;
let cpo: MockCpo;
let cpo2: MockCpo;
let net: ReturnType<typeof inProcessNetwork>;
let one: Peer;
let two: Peer;
let events: SessionEvent[];
let unsubscribe: () => void;
const saved = { ...process.env };
const client: ClientOptions = { retries: 0, timeoutMs: 500 };

const commandDeps = (over: Partial<CommandDeps> = {}): CommandDeps => ({
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

beforeEach(async () => {
  Object.assign(process.env, LIVE_ENV);
  delete process.env.DEMO_MODE;
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
  vi.spyOn(console, "error").mockImplementation(() => {});
  events = [];
  unsubscribe = onSessionEvent((e) => {
    events.push(e);
  });

  // We register at one CPO; the other registers with us.
  one = await connectToCpo(
    {
      label: "Mock CPO",
      versionsUrl: cpo.urls.versions,
      tokenA: cpo.issueTokenA(),
    },
    { store: peers, client },
  );
  const invite = await invitePeer({ label: "Second CPO" }, { store: peers });
  await cpo2.registerWith(invite.versionsUrl, invite.tokenA);
  two = (await peers.getPeer(invite.peer.id))!;
  await locations.saveLocations(one.id, cpo.state.locations, T0.toISOString());
  await locations.saveLocations(two.id, cpo2.state.locations, T0.toISOString());
  for (const driverRef of [DRIVER, "driver-2"])
    await createAppToken(
      { driverRef },
      { tokens, peers, client, actor: "test" },
    );
});

afterEach(() => {
  unsubscribe();
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

let seq = 0;
const newRequestId = () => `req-${String(++seq).padStart(6, "0")}`;

/** The driver taps start; the mock CPO accepts and starts a session for it. */
async function started(
  driverRef = DRIVER,
  id = "SESSION-1",
  { minutes = 0 } = {},
): Promise<{ commandId: string; session: Session }> {
  const { command } = await startSession(
    {
      driverRef,
      requestId: newRequestId(),
      locationId: locationAppId({
        peerId: one.id,
        countryCode: "ZZ",
        partyId: "MCK",
        id: "LOC1",
      }),
      evseUid: "LOC1-1",
      connectorId: "1",
    },
    commandDeps(),
  );
  await cpo.sendCommandResult("ACCEPTED");
  return {
    commandId: command.id,
    session: cpo.sessionForCommand({ id, at: at(minutes) }),
  };
}

const key = (sessionId = "SESSION-1", peer: Peer = one, party = cpo.party) => ({
  peerId: peer.id,
  countryCode: party.countryCode,
  partyId: party.partyId,
  sessionId,
});

const held = async (sessionId = "SESSION-1") =>
  (await sessions.getSession(key(sessionId)))!;
const types = () => events.map((e) => e.type);

const period = (minutes: number, kwh: number) => ({
  start_date_time: iso(minutes),
  dimensions: [{ type: "ENERGY" as const, volume: kwh }],
});

describe("the Sessions and CDRs modules", () => {
  it("lists our Receivers, and sees each CPO's Senders", async () => {
    const res = await ocpiRequest(
      { url: EMSP, token: cpo.state.emsp!.token },
      { transport: net.transport },
    );
    expect(res.data).toMatchObject({
      endpoints: expect.arrayContaining([
        { identifier: "sessions", role: "RECEIVER", url: `${EMSP}/sessions` },
        { identifier: "cdrs", role: "RECEIVER", url: `${EMSP}/cdrs` },
      ]),
    });
    expect(one.endpoints).toEqual(
      expect.arrayContaining([
        { identifier: "sessions", role: "SENDER", url: cpo.urls.sessions },
        { identifier: "cdrs", role: "SENDER", url: cpo.urls.cdrs },
      ]),
    );
  });
});

describe("sessions pushed by a CPO", () => {
  it("stores a session PUT, links it to the driver's start and token, and emits started", async () => {
    const { commandId, session } = await started();
    await cpo.putSession(session, { push: true });
    const s = await held();
    expect(s).toMatchObject({
      peerId: one.id,
      session,
      driverRef: DRIVER,
      commandId,
      completedAt: null,
    });
    // The start now knows its session, so the driver can stop it.
    expect((await commands.get(commandId))!.sessionId).toBe("SESSION-1");
    const stop = await stopSession(
      {
        driverRef: DRIVER,
        requestId: newRequestId(),
        peerId: one.id,
        sessionId: "SESSION-1",
      },
      commandDeps(),
    );
    expect(stop.command.status).toBe("accepted");
    expect(types()).toEqual(["session.started"]);
    expect(peers.auditLog.map((a) => a.action)).toContain("session.started");
    // The audit names the session, never the driver or the token.
    const entry = peers.auditLog.find((a) => a.action === "session.started")!;
    expect(JSON.stringify(entry)).not.toContain(DRIVER);
    expect(JSON.stringify(entry)).not.toContain(session.cdr_token.uid);

    // The CPO can read it back.
    const res = await ocpiRequest(
      {
        url: `${EMSP}/sessions/ZZ/MCK/SESSION-1`,
        token: cpo.state.emsp!.token,
        routing: {
          from: cpo.party,
          to: { countryCode: "NL", partyId: "ABC" },
        },
      },
      { transport: net.transport, retries: 0 },
    );
    expect(res.data).toEqual(session);
  });

  it("applies PATCHes: live kWh, cost, status and charging periods, and completes once", async () => {
    const { session } = await started();
    await cpo.putSession(session, { push: true });
    await cpo.patchSession(
      "SESSION-1",
      {
        kwh: 5.5,
        charging_periods: [period(0, 5.5)],
        total_cost: { excl_vat: 3.25, incl_vat: 3.93 },
      },
      { push: true, at: at(10) },
    );
    expect((await held()).session).toMatchObject({
      kwh: 5.5,
      total_cost: { excl_vat: 3.25, incl_vat: 3.93 },
      charging_periods: [period(0, 5.5)],
      status: "ACTIVE",
      last_updated: iso(10),
    });
    await cpo.patchSession(
      "SESSION-1",
      {
        kwh: 12,
        charging_periods: [period(10, 6.5)],
        status: "COMPLETED",
        end_date_time: iso(20),
      },
      { push: true, at: at(20) },
    );
    const s = await held();
    expect(s.session).toMatchObject({
      kwh: 12,
      status: "COMPLETED",
      end_date_time: iso(20),
      charging_periods: [period(0, 5.5), period(10, 6.5)],
    });
    expect(s.completedAt).not.toBeNull();
    expect(types()).toEqual([
      "session.started",
      "session.updated",
      "session.updated",
      "session.completed",
    ]);
    // The same change again changes nothing and emits nothing.
    await cpo.putSession(cpo.state.sessions[0], { push: true });
    expect(types()).toHaveLength(4);
  });

  it("keeps the newest fields and every charging period when PATCHes arrive out of order", async () => {
    const { session } = await started();
    await cpo.putSession(session, { push: true });
    // The CPO sends each new period once; the two PATCHes overtake each other.
    const first = await cpo.patchSession(
      "SESSION-1",
      { kwh: 4, charging_periods: [period(0, 4)] },
      { at: at(5) },
    );
    const second = await cpo.patchSession(
      "SESSION-1",
      { kwh: 9, charging_periods: [period(5, 5)] },
      { at: at(10) },
    );
    const done = await cpo.patchSession(
      "SESSION-1",
      { status: "COMPLETED", end_date_time: iso(12) },
      { at: at(12) },
    );
    await cpo.sendSessionPatch("SESSION-1", done);
    await cpo.sendSessionPatch("SESSION-1", second);
    await cpo.sendSessionPatch("SESSION-1", first);
    const s = (await held()).session;
    expect(s).toMatchObject({
      kwh: 9,
      status: "COMPLETED",
      end_date_time: iso(12),
      last_updated: iso(12),
      charging_periods: [period(0, 4), period(5, 5)],
    });
    // It ends as the CPO's own copy does.
    expect(s).toEqual(cpo.state.sessions[0]);
    expect(types().filter((t) => t === "session.completed")).toHaveLength(1);
    // A late PATCH with nothing new is acknowledged and changes nothing.
    const before = events.length;
    const res = await cpo.sendSessionPatch("SESSION-1", {
      status: "ACTIVE",
      last_updated: iso(1),
    });
    expect(res.statusCode).toBe(1000);
    expect((await held()).session.status).toBe("COMPLETED");
    expect(events).toHaveLength(before);
  });

  it("never lets a late change roll a charging period back", async () => {
    const { session } = await started();
    await cpo.putSession(
      { ...session, charging_periods: [period(0, 1)] },
      { push: true },
    );
    // A PATCH at t10 sets the first period to 9 kWh ...
    await cpo.sendSessionPatch("SESSION-1", {
      kwh: 9,
      charging_periods: [period(0, 9)],
      last_updated: iso(10),
    });
    // ... and a PUT from t5, delayed, still says 4 for it, and adds a period.
    await cpo.putSession(
      {
        ...session,
        kwh: 4,
        charging_periods: [period(0, 4), period(4, 0.5)],
        last_updated: iso(5),
      },
      { push: true },
    );
    expect((await held()).session).toMatchObject({
      kwh: 9,
      charging_periods: [period(0, 9), period(4, 0.5)],
      last_updated: iso(10),
    });
    // A newer change does replace it.
    await cpo.sendSessionPatch("SESSION-1", {
      charging_periods: [period(0, 9.5)],
      last_updated: iso(15),
    });
    expect((await held()).session.charging_periods).toEqual([
      period(0, 9.5),
      period(4, 0.5),
    ]);
  });

  it("completes a session whose CDR arrived while its first PUT was being stored", async () => {
    const { session } = await started();
    await cpo.putSession({ ...session, status: "COMPLETED" });
    const cdr = cpo.cdrFor("SESSION-1");
    const deps = { sessions, commands, tokens, peers };
    const insert = sessions.insertSession.bind(sessions);
    // The CDR lands after the session write looked for one, before it is stored.
    vi.spyOn(sessions, "insertSession").mockImplementationOnce(
      async (...args) => {
        await recordCdr(one, cdr, "push", deps);
        return insert(...args);
      },
    );
    const { session: stored } = await recordSession(
      one,
      { ...session, status: "ACTIVE" },
      deps,
    );
    expect(stored.completedAt).not.toBeNull();
    expect((await held()).completedAt).not.toBeNull();
    expect(types()).toEqual([
      "cdr.received",
      "session.started",
      "session.completed",
    ]);
  });

  it("lands every PATCH when many arrive at once", async () => {
    const { session } = await started();
    await cpo.putSession(session, { push: true });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        cpo.sendSessionPatch("SESSION-1", {
          charging_periods: [period(i, 1)],
          last_updated: iso(i + 1),
        }),
      ),
    );
    const s = (await held()).session;
    expect(s.charging_periods).toHaveLength(12);
    expect(s.last_updated).toBe(iso(12));
  });

  it("keeps two CPOs' sessions with the same ID apart", async () => {
    const { session } = await started();
    await cpo.putSession(session, { push: true });
    const theirs: Session = {
      ...session,
      country_code: "YY",
      party_id: "TWO",
      cdr_token: sampleCdrToken({ countryCode: "XX", partyId: "OTH" }),
      kwh: 99,
    };
    delete theirs.authorization_reference;
    await cpo2.putSession(theirs, { push: true });
    expect((await held()).session.kwh).toBe(0);
    const other = (await sessions.getSession(
      key("SESSION-1", two, cpo2.party),
    ))!;
    // Not our token, and no start of ours: linked to nobody.
    expect(other).toMatchObject({
      session: { kwh: 99 },
      driverRef: null,
      commandId: null,
    });
  });

  it("refuses invalid sessions, other parties, unknown sessions and unknown peers", async () => {
    const { session } = await started();
    const put = (path: string, body: unknown, token = cpo.state.emsp!.token) =>
      ocpiRequest(
        {
          method: "PUT",
          url: `${EMSP}/sessions/${path}`,
          token,
          body,
          routing: {
            from: cpo.party,
            to: { countryCode: "NL", partyId: "ABC" },
          },
        },
        { transport: net.transport, retries: 0 },
      );
    await expect(
      put("ZZ/MCK/SESSION-1", { ...session, kwh: -1 }),
    ).rejects.toMatchObject({ statusCode: 2001, httpStatus: 400 });
    await expect(
      put("ZZ/MCK/SESSION-1", { ...session, status: "CHARGING" }),
    ).rejects.toMatchObject({ statusCode: 2001 });
    await expect(
      put("ZZ/MCK/SESSION-1", { ...session, id: "SESSION-2" }),
    ).rejects.toMatchObject({ statusCode: 2001 });
    // Another CPO's party, in the URL.
    await expect(
      put("YY/TWO/SESSION-1", { ...session, country_code: "YY" }),
    ).rejects.toMatchObject({ httpStatus: 403 });
    await expect(
      put("ZZ/MCK/SESSION-1", session, "not-a-token"),
    ).rejects.toMatchObject({ httpStatus: 401 });
    await expect(
      cpo.sendSessionPatch("SESSION-404", { kwh: 1, last_updated: iso(1) }),
    ).rejects.toMatchObject({ statusCode: 2000, httpStatus: 404 });
    await cpo.putSession(session, { push: true });
    await expect(
      cpo.sendSessionPatch("SESSION-1", { kwh: 1 }),
    ).rejects.toMatchObject({ statusCode: 2001 });
    await expect(
      cpo.sendSessionPatch("SESSION-1", { kwh: "lots", last_updated: iso(1) }),
    ).rejects.toMatchObject({ statusCode: 2001 });
    expect((await held()).session.kwh).toBe(0);
  });

  it("takes a push only from the CPO party in OCPI-from, on a peer with several", async () => {
    // The peer runs a second CPO party behind the same token.
    await peers.updatePeer(one.id, {
      roles: [
        ...one.roles,
        {
          role: "CPO",
          business_details: { name: "Mock CPO, second brand" },
          country_code: "ZZ",
          party_id: "OTH",
        },
      ],
    });
    const { session } = await started();
    const send = (
      method: "PUT" | "POST" | "GET",
      path: string,
      body: unknown,
      from: string,
    ) =>
      ocpiRequest(
        {
          method,
          url: `${EMSP}/${path}`,
          token: cpo.state.emsp!.token,
          body,
          routing: {
            from: { countryCode: "ZZ", partyId: from },
            to: { countryCode: "NL", partyId: "ABC" },
          },
        },
        { transport: net.transport, retries: 0 },
      );
    const forbidden = { httpStatus: 403 };
    const theirs = { ...session, party_id: "OTH" };

    // Sessions: the URL's party (and the body's) must be the OCPI-from party.
    await expect(
      send("PUT", "sessions/ZZ/OTH/SESSION-1", theirs, "MCK"),
    ).rejects.toMatchObject(forbidden);
    await expect(
      send("PUT", "sessions/ZZ/MCK/SESSION-1", session, "OTH"),
    ).rejects.toMatchObject(forbidden);
    await expect(
      send("PUT", "sessions/ZZ/OTH/SESSION-1", session, "OTH"),
    ).rejects.toMatchObject({ statusCode: 2001 });
    expect(sessions.sessions.size).toBe(0);
    expect(
      (await send("PUT", "sessions/ZZ/OTH/SESSION-1", theirs, "OTH"))
        .statusCode,
    ).toBe(1000);

    // CDRs: the CDR's party must be the OCPI-from party, to post and to read back.
    await cpo.putSession(session);
    const cdr = cpo.cdrFor("SESSION-1");
    await expect(
      send("POST", "cdrs", { ...cdr, party_id: "OTH" }, "MCK"),
    ).rejects.toMatchObject(forbidden);
    await expect(send("POST", "cdrs", cdr, "OTH")).rejects.toMatchObject(
      forbidden,
    );
    expect(sessions.cdrs.size).toBe(0);
    const res = await send("POST", "cdrs", cdr, "MCK");
    const location = res.headers.get("Location")!;
    const url = location.slice(EMSP.length + 1);
    await expect(send("GET", url, undefined, "OTH")).rejects.toMatchObject({
      httpStatus: 404,
    });
    expect((await send("GET", url, undefined, "MCK")).data).toEqual(cdr);

    // Locations and tariffs: the same.
    const location1 = cpo.state.locations[0];
    const tariff = cpo.state.tariffs[0];
    await expect(
      send(
        "PUT",
        `locations/ZZ/OTH/${location1.id}`,
        { ...location1, party_id: "OTH" },
        "MCK",
      ),
    ).rejects.toMatchObject(forbidden);
    await expect(
      send("PUT", `locations/ZZ/MCK/${location1.id}`, location1, "OTH"),
    ).rejects.toMatchObject(forbidden);
    await expect(
      send(
        "PUT",
        `tariffs/ZZ/OTH/${tariff.id}`,
        { ...tariff, party_id: "OTH" },
        "MCK",
      ),
    ).rejects.toMatchObject(forbidden);
    await expect(
      send("PUT", `tariffs/ZZ/MCK/${tariff.id}`, tariff, "OTH"),
    ).rejects.toMatchObject(forbidden);
    expect(
      (
        await send(
          "PUT",
          `tariffs/ZZ/OTH/${tariff.id}`,
          { ...tariff, party_id: "OTH" },
          "OTH",
        )
      ).statusCode,
    ).toBe(1000);
  });

  it("links a session to the driver by token when no start of ours names it", async () => {
    const token = (await tokens.listByDriver("driver-2"))[0];
    const session: Session = {
      ...(await started()).session,
      id: "RFID-1",
      auth_method: "WHITELIST",
      cdr_token: {
        country_code: "NL",
        party_id: "ABC",
        uid: token.uid.toLowerCase(),
        type: "APP_USER",
        contract_id: token.contractId,
      },
    };
    delete session.authorization_reference;
    await cpo.putSession(session, { push: true });
    expect(await held("RFID-1")).toMatchObject({
      driverRef: "driver-2",
      commandId: null,
    });
    // The driver may stop it with the sessions module as the session owner.
    const owner = sessionOwner(sessions);
    const stop = (driverRef: string) =>
      stopSession(
        {
          driverRef,
          requestId: newRequestId(),
          peerId: one.id,
          sessionId: "RFID-1",
        },
        commandDeps({ sessionOwner: owner }),
      );
    await expect(stop(DRIVER)).rejects.toMatchObject({ httpStatus: 404 });
    expect((await stop("driver-2")).command.status).toBe("accepted");
    expect(cpo.state.commands.at(-1)).toMatchObject({
      type: "STOP_SESSION",
      body: { session_id: "RFID-1" },
    });
  });

  it("never fails the CPO's push over a listener", async () => {
    const off = onSessionEvent(() => {
      throw new Error("listener down");
    });
    const { session } = await started();
    await expect(
      cpo.putSession(session, { push: true }),
    ).resolves.toBeUndefined();
    off();
    expect(await held()).toBeTruthy();
    expect(types()).toEqual(["session.started"]);
  });
});

describe("CDRs pushed by a CPO", () => {
  it("stores a CDR before the session ends, answers with its URL, and completes the session once", async () => {
    const { commandId, session } = await started();
    await cpo.putSession(session, { push: true });
    await cpo.patchSession(
      "SESSION-1",
      { kwh: 7, charging_periods: [period(0, 7)], end_date_time: iso(30) },
      { push: true, at: at(30) },
    );
    // The CDR overtakes the COMPLETED PATCH.
    const cdr = cpo.cdrFor("SESSION-1", {
      totalCost: { excl_vat: 4.13, incl_vat: 5 },
    });
    const location = await cpo.postCdr(cdr, { push: true });
    const stored = (await sessions.getCdr({
      peerId: one.id,
      countryCode: "ZZ",
      partyId: "MCK",
      cdrId: cdr.id,
    }))!;
    expect(stored).toMatchObject({
      cdr,
      driverRef: DRIVER,
      commandId,
      source: "push",
    });
    expect(location).toBe(`${EMSP}/cdrs/${stored.id}`);
    expect((await held()).completedAt).not.toBeNull();
    expect(types()).toEqual([
      "session.started",
      "session.updated",
      "cdr.received",
      "session.completed",
    ]);
    // The COMPLETED PATCH lands later: an update, never a second completion.
    await cpo.patchSession(
      "SESSION-1",
      { status: "COMPLETED" },
      { push: true, at: at(31) },
    );
    expect(types().filter((t) => t === "session.completed")).toHaveLength(1);
    expect((await held()).session.status).toBe("COMPLETED");

    // The CPO reads it back at that URL; another CPO cannot.
    const get = (mock: MockCpo) =>
      ocpiRequest(
        {
          url: location!,
          token: mock.state.emsp!.token,
          routing: {
            from: mock.party,
            to: { countryCode: "NL", partyId: "ABC" },
          },
        },
        { transport: net.transport, retries: 0 },
      );
    expect((await get(cpo)).data).toEqual(cdr);
    await expect(get(cpo2)).rejects.toMatchObject({
      statusCode: 2000,
      httpStatus: 404,
    });
  });

  it("keeps a CDR as it first arrived: the same again is acknowledged, a changed one refused", async () => {
    const { session } = await started();
    await cpo.putSession(
      { ...session, status: "COMPLETED", end_date_time: iso(20) },
      { push: true },
    );
    const cdr = cpo.cdrFor("SESSION-1");
    const first = await cpo.postCdr(cdr, { push: true });
    const count = events.length;
    // A retry, even with another last_updated, is the same CDR.
    expect(
      await cpo.postCdr({ ...cdr, last_updated: iso(99) }, { push: true }),
    ).toBe(first);
    expect(events).toHaveLength(count);
    await expect(
      cpo.postCdr({ ...cdr, total_cost: { excl_vat: 999 } }, { push: true }),
    ).rejects.toMatchObject({ statusCode: 2001, httpStatus: 400 });
    const stored = (await sessions.getCdr({
      peerId: one.id,
      countryCode: "ZZ",
      partyId: "MCK",
      cdrId: cdr.id,
    }))!;
    expect(stored.cdr).toEqual(cdr);
    expect(peers.auditLog.map((a) => a.action)).toContain("cdr.conflict");
  });

  it("refuses invalid CDRs and another party's", async () => {
    const { session } = await started();
    await cpo.putSession(session, { push: true });
    const cdr = cpo.cdrFor("SESSION-1");
    await expect(
      cpo.postCdr({ ...cdr, charging_periods: [] }, { push: true }),
    ).rejects.toMatchObject({ statusCode: 2001 });
    await expect(
      cpo.postCdr({ ...cdr, credit: true } as typeof cdr, { push: true }),
    ).rejects.toMatchObject({ statusCode: 2001 });
    await expect(
      cpo.postCdr({ ...cdr, party_id: "TWO" }, { push: true }),
    ).rejects.toMatchObject({ httpStatus: 403 });
    expect(sessions.cdrs.size).toBe(0);
  });

  it("takes a CDR for a session it never saw, and links it by start and token", async () => {
    const { commandId } = await started();
    const session = cpo.sessionForCommand({ id: "SESSION-9", at: at(0) });
    await cpo.putSession({ ...session, kwh: 3 }); // not pushed
    await cpo.postCdr(cpo.cdrFor("SESSION-9"), { push: true });
    const [stored] = sessions.cdrs.values();
    expect(stored).toMatchObject({ driverRef: DRIVER, commandId });
    expect(types()).toEqual(["cdr.received"]);
    // When the session turns up later, it is complete at once.
    await cpo.putSession(
      { ...session, kwh: 3, status: "ACTIVE" },
      { push: true },
    );
    expect(types()).toEqual([
      "cdr.received",
      "session.started",
      "session.completed",
    ]);
  });
});

describe("CDRs and the driver's start", () => {
  const stored = async (cdrId: string) =>
    (await sessions.getCdr({
      peerId: one.id,
      countryCode: "ZZ",
      partyId: "MCK",
      cdrId,
    }))!;

  it("links a CDR to a start only for the session that start is linked to", async () => {
    const { commandId, session } = await started();
    await cpo.putSession(session, { push: true });
    // Another session (or a CPO's mistake) with the same authorization_reference.
    await cpo.putSession({ ...session, id: "SESSION-B" });
    await cpo.postCdr(cpo.cdrFor("SESSION-1", { id: "CDR-A" }), {
      push: true,
    });
    await cpo.postCdr(cpo.cdrFor("SESSION-B", { id: "CDR-B" }), {
      push: true,
    });
    const noSession = { ...cpo.cdrFor("SESSION-1"), id: "CDR-C" };
    delete noSession.session_id;
    await cpo.postCdr(noSession, { push: true });
    expect(await stored("CDR-A")).toMatchObject({ commandId });
    // Not this start's session: never its hold. Still the driver's, by token.
    expect(await stored("CDR-B")).toMatchObject({
      commandId: null,
      driverRef: DRIVER,
    });
    expect(await stored("CDR-C")).toMatchObject({ commandId: null });
    expect((await commands.get(commandId))!.sessionId).toBe("SESSION-1");
  });

  it("lets the first CDR claim a start no session is linked to yet", async () => {
    const { commandId, session } = await started();
    await cpo.putSession(session);
    await cpo.putSession({ ...session, id: "SESSION-B" });
    await cpo.postCdr(cpo.cdrFor("SESSION-1", { id: "CDR-A" }), {
      push: true,
    });
    await cpo.postCdr(cpo.cdrFor("SESSION-B", { id: "CDR-B" }), {
      push: true,
    });
    expect(await stored("CDR-A")).toMatchObject({ commandId });
    expect(await stored("CDR-B")).toMatchObject({ commandId: null });
    expect((await commands.get(commandId))!.sessionId).toBe("SESSION-1");
    // The session that turns up later is that start's; the other is not.
    await cpo.putSession(session, { push: true });
    await cpo.putSession({ ...session, id: "SESSION-B" }, { push: true });
    expect((await held()).commandId).toBe(commandId);
    expect((await held("SESSION-B")).commandId).toBeNull();
  });
});

describe("sessions and CDRs pulled from a CPO", () => {
  // A pull asks for changes since the peer was added (the real clock), so these are
  // dated from now on.
  const recent = (minutes = 0) =>
    ocpiTimestamp(new Date(Date.now() + minutes * 60_000));

  it("pulls every page with date_from, links them, and changes nothing on the next pull", async () => {
    // The second CPO pushes nothing: its sessions and CDRs are only on its Senders.
    const uid = (await tokens.listByDriver(DRIVER))[0].uid;
    const s = (n: number): Session => ({
      country_code: "YY",
      party_id: "TWO",
      id: `S${n}`,
      start_date_time: recent(n),
      end_date_time: recent(n + 30),
      kwh: n,
      cdr_token: {
        ...sampleCdrToken({ countryCode: "NL", partyId: "ABC" }),
        uid,
      },
      auth_method: "WHITELIST",
      location_id: "LOC1",
      evse_uid: "LOC1-1",
      connector_id: "1",
      currency: "EUR",
      status: "COMPLETED",
      last_updated: recent(n + 31),
    });
    for (let n = 1; n <= 5; n++) await cpo2.putSession(s(n));
    await cpo2.postCdr(cpo2.cdrFor("S1"));
    await cpo2.postCdr(cpo2.cdrFor("S2"));

    const report = await pullSessions(two.id, "sessions", pullDeps());
    expect(report).toMatchObject({
      mode: "full",
      complete: true,
      pages: 3,
      items: 5,
      invalid: 0,
    });
    // The first pull starts when the peer was added, less 5 minutes.
    const firstPage = net.calls.find((c) =>
      c.url.startsWith(cpo2.urls.sessions),
    )!;
    const dateFrom = new URL(firstPage.url).searchParams.get("date_from")!;
    expect(Date.parse(dateFrom)).toBe(
      Math.floor((Date.parse(two.createdAt) - 5 * 60_000) / 1000) * 1000,
    );
    expect((await pullSessions(two.id, "cdrs", pullDeps())).items).toBe(2);

    const stored = (await sessions.getSession(key("S1", two, cpo2.party)))!;
    expect(stored).toMatchObject({ driverRef: DRIVER, commandId: null });
    expect(stored.completedAt).not.toBeNull();
    const [cdr] = sessions.cdrs.values();
    expect(cdr).toMatchObject({ source: "pull", driverRef: DRIVER });
    expect(types().filter((t) => t === "session.started")).toHaveLength(5);
    expect(types().filter((t) => t === "cdr.received")).toHaveLength(2);

    // The next pull asks for changes since the last one, and nothing is new.
    const before = events.length;
    const again = await pullSessions(two.id, "sessions", pullDeps());
    expect(again.mode).toBe("incremental");
    await pullSessions(two.id, "cdrs", pullDeps());
    expect(events).toHaveLength(before);
  });

  it("resumes a pull that failed at the page it stopped at", async () => {
    const { session } = await started();
    for (let n = 1; n <= 5; n++)
      await cpo.putSession({ ...session, id: `S${n}`, last_updated: recent() });
    const pages: string[] = [];
    const deps = pullDeps();
    // The second page fails, and the client does not retry (retries: 0).
    let calls = 0;
    const transport = net.transport;
    deps.client = {
      ...client,
      transport: async (url, init) => {
        if (url.startsWith(cpo.urls.sessions)) {
          pages.push(url);
          if (++calls === 2) throw new TypeError("fetch failed");
        }
        return transport(url, init);
      },
    };
    await expect(pullSessions(one.id, "sessions", deps)).rejects.toThrow(
      "Pulling sessions",
    );
    expect(sessions.sessions.size).toBe(2);
    const report = await pullSessions(one.id, "sessions", deps);
    expect(report).toMatchObject({ resumed: true, complete: true, items: 5 });
    expect(sessions.sessions.size).toBe(5);
    // It went on at the failed page, not at the first one.
    expect(pages[2]).toBe(pages[1]);
  });

  it("skips an object it cannot store, and goes on with the rest of the page", async () => {
    const { session } = await started();
    for (let n = 1; n <= 3; n++)
      await cpo.putSession({ ...session, id: `S${n}`, last_updated: recent() });
    // S2 stays busy: every write of it loses.
    const insert = sessions.insertSession.bind(sessions);
    vi.spyOn(sessions, "insertSession").mockImplementation(
      async (peerId, write, now) =>
        write.session.id === "S2" ? null : insert(peerId, write, now),
    );
    const report = await pullSessions(one.id, "sessions", pullDeps());
    expect(report).toMatchObject({ complete: true, items: 2, invalid: 1 });
    expect([...sessions.sessions.values()].map((s) => s.session.id)).toEqual([
      "S1",
      "S3",
    ]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("skipped ZZ/MCK/S2"),
    );
  });

  it("never lets an older pulled version replace a newer pushed one", async () => {
    const { session } = await started();
    await cpo.putSession(
      { ...session, kwh: 1, last_updated: recent() },
      { push: true },
    );
    // A push lands that the CPO's Sender does not serve yet (an older copy).
    await cpo.sendSessionPatch("SESSION-1", {
      kwh: 8,
      last_updated: recent(15),
    });
    const report = await pullSessions(one.id, "sessions", pullDeps());
    expect(report.items).toBe(1);
    expect((await held()).session.kwh).toBe(8);
  });

  it("skips invalid objects and other parties' objects, and pulls every registered peer", async () => {
    const session = { ...(await started()).session, last_updated: recent() };
    await cpo.putSession(session);
    cpo.state.sessions.push(
      { ...session, id: "BAD", kwh: -3 },
      { ...session, id: "OTHER", party_id: "TWO" },
    );
    const results = await pullAllSessions(pullDeps());
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          peerId: one.id,
          module: "sessions",
          ok: true,
          items: 1,
          invalid: 2,
        }),
        expect.objectContaining({ peerId: two.id, module: "cdrs", ok: true }),
      ]),
    );
    expect(sessions.sessions.size).toBe(1);
  });

  it("refuses to pull in demo mode, and sends nothing", async () => {
    process.env.DEMO_MODE = "true";
    const before = net.calls.length;
    await expect(pullAllSessions(pullDeps())).rejects.toThrow("Demo mode");
    await expect(pullSessions(one.id, "sessions", pullDeps())).rejects.toThrow(
      "Demo mode",
    );
    expect(net.calls.length).toBe(before);
  });
});

describe("demo mode", () => {
  it("holds the mock CPO's sample sessions and CDRs, offline, with their reconciliation", async () => {
    uninstallNetwork();
    const fetchSpy = vi.fn(() => {
      throw new Error("demo mode must not call fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
    process.env.DEMO_MODE = "true";
    setSessionStoreForTests(undefined);
    const store = sessionStore();
    expect(store).toBe(sessionStore());
    const party = { peerId: DEMO_PEER_ID, countryCode: "ZZ", partyId: "MCK" };
    expect(
      (await store.getSession({ ...party, sessionId: "S3" }))!.session.status,
    ).toBe("ACTIVE");
    expect(await store.getCdr({ ...party, cdrId: "CDR-S1" })).toMatchObject({
      cdr: { session_id: "S1" },
    });
    const { days } = await reconcile(
      { from: "2026-09-30", to: "2026-09-30" },
      { sessions: store },
    );
    expect(days).toMatchObject([
      {
        peerId: DEMO_PEER_ID,
        sessions: 3,
        sessionsOpen: 1,
        sessionsWithoutCdr: 1,
        sessionsWithoutCdrIds: ["ZZ/MCK/S2"],
        cdrs: 1,
      },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
