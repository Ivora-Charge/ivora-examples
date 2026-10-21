import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyCommandResult,
  CLAIM_TTL_MS,
  CommandError,
  expireCommands,
  getCommand,
  linkSession,
  RESULT_GRACE_MS,
  startSession,
  stopSession,
  UNCERTAIN_WAIT_MS,
  type CommandDeps,
} from "@/lib/commands/manage";
import { setPreAuthForTests, type HoldResult } from "@/lib/commands/pre-auth";
import { setCommandStoreForTests } from "@/lib/commands/registry";
import { MemoryCommandStore, type Command } from "@/lib/commands/store";
import {
  DEMO_PEER_ID,
  setLocationStoreForTests,
} from "@/lib/locations/registry";
import { locationAppId } from "@/lib/locations/search";
import { MemoryLocationStore } from "@/lib/locations/store";
import { createMockCpo, type MockCpo } from "@/lib/mock-cpo";
import { sampleLocations } from "@/lib/mock-cpo/sample-data";
import { ocpiRequest, type ClientOptions } from "@/lib/ocpi/client";
import {
  COMMAND_RESULT_TYPES,
  parseStartSession,
  type CommandResultType,
} from "@/lib/ocpi/command-objects";
import { connectToCpo, invitePeer } from "@/lib/ocpi/handshake";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { MemoryPeerStore, type Peer } from "@/lib/ocpi/store";
import { createAppToken, blockToken } from "@/lib/tokens/manage";
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

let peers: MemoryPeerStore;
let tokens: MemoryTokenStore;
let locations: MemoryLocationStore;
let commands: MemoryCommandStore;
let cpo: MockCpo;
let cpo2: MockCpo;
let net: ReturnType<typeof inProcessNetwork>;
let clock: Date;
let one: Peer;
let two: Peer;
const saved = { ...process.env };
const client: ClientOptions = { retries: 0, timeoutMs: 500 };

/** The payment hook: records what it is asked, in order with what the CPO receives. */
let events: string[];
let nextHold: HoldResult | Error;
let releases: { id: string; uncertain: boolean }[];

const deps = (over: Partial<CommandDeps> = {}): CommandDeps => ({
  commands,
  peers,
  tokens,
  locations,
  client,
  now: () => clock,
  ...over,
});

beforeEach(async () => {
  Object.assign(process.env, LIVE_ENV);
  delete process.env.DEMO_MODE;
  peers = new MemoryPeerStore();
  tokens = new MemoryTokenStore(peers);
  locations = new MemoryLocationStore();
  commands = new MemoryCommandStore();
  setPeerStoreForTests(peers);
  setTokenStoreForTests(tokens);
  setLocationStoreForTests(locations);
  setCommandStoreForTests(commands);
  clock = T0;
  events = [];
  releases = [];
  nextHold = { ok: true, reference: "hold-1" };
  setPreAuthForTests({
    async hold(c) {
      events.push(`hold:${c.id}`);
      if (nextHold instanceof Error) throw nextHold;
      return nextHold;
    },
    async release(c, why) {
      events.push(`release:${c.id}`);
      releases.push({ id: c.id, uncertain: why.uncertain });
    },
  });
  net = inProcessNetwork({
    "emsp.example.test": emspHandler,
    "mock-cpo.example.test": (r) => {
      if (new URL(r.url).pathname.startsWith("/ocpi/2.2.1/commands/"))
        events.push("cpo:command");
      return cpo.handle(r);
    },
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

  // We register at one CPO; the other registers with us. Both have the same IDs.
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
  const seenAt = T0.toISOString();
  await locations.saveLocations(one.id, cpo.state.locations, seenAt);
  await locations.saveLocations(two.id, cpo2.state.locations, seenAt);
  await createAppToken(
    { driverRef: DRIVER },
    { tokens, peers, client, actor: "test" },
  );
  await createAppToken(
    { driverRef: "driver-2" },
    { tokens, peers, client, actor: "test" },
  );
});

afterEach(() => {
  uninstallNetwork();
  setPeerStoreForTests(undefined);
  setTokenStoreForTests(undefined);
  setLocationStoreForTests(undefined);
  setCommandStoreForTests(undefined);
  setPreAuthForTests(undefined);
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const loc = (peer: Peer = one, id = "LOC1", party = cpo.party) =>
  locationAppId({
    peerId: peer.id,
    countryCode: party.countryCode,
    partyId: party.partyId,
    id,
  });

let seq = 0;
const newRequestId = () => `req-${String(++seq).padStart(6, "0")}`;

const start = (over: Partial<Parameters<typeof startSession>[0]> = {}) =>
  startSession(
    {
      driverRef: DRIVER,
      requestId: newRequestId(),
      locationId: loc(),
      evseUid: "LOC1-1",
      connectorId: "1",
      ...over,
    },
    deps(),
  );

const stored = async (id: string) => (await commands.get(id)) as Command;

describe("START_SESSION", () => {
  it("lists our commands Sender, and sees the CPO's commands Receiver", async () => {
    expect(one.endpoints).toContainEqual({
      identifier: "commands",
      role: "RECEIVER",
      url: cpo.urls.commands,
    });
    const res = await ocpiRequest(
      { url: EMSP, token: cpo.state.emsp!.token },
      { transport: net.transport },
    );
    expect(res.data).toMatchObject({
      endpoints: expect.arrayContaining([
        { identifier: "commands", role: "SENDER", url: `${EMSP}/commands` },
      ]),
    });
  });

  it("holds payment first, then sends a valid StartSession to the location's CPO, and succeeds on ACCEPTED", async () => {
    const { state, command } = await start();
    expect(state).toBe("created");
    expect(command).toMatchObject({
      status: "accepted",
      pending: true,
      result: "ACCEPTED",
      message: "Waiting for the charger…",
    });
    // The hold came first, then the command; nothing went to the other CPO.
    expect(events).toEqual([`hold:${command.id}`, "cpo:command"]);
    expect(cpo2.state.commands).toEqual([]);

    const [sent] = cpo.state.commands;
    expect(sent.type).toBe("START_SESSION");
    const token = (await tokens.listByDriver(DRIVER))[0];
    const c = await stored(command.id);
    expect(sent.body).toEqual({
      response_url: `${EMSP}/commands/START_SESSION/${command.id}`,
      token: expect.objectContaining({
        uid: token.uid,
        type: "APP_USER",
        contract_id: token.contractId,
        valid: true,
      }),
      location_id: "LOC1",
      evse_uid: "LOC1-1",
      connector_id: "1",
      authorization_reference: c.authorizationReference,
    });
    expect(parseStartSession(sent.body).ok).toBe(true);
    expect(sent.headers).toMatchObject({
      "ocpi-from-country-code": "NL",
      "ocpi-from-party-id": "ABC",
      "ocpi-to-country-code": "ZZ",
      "ocpi-to-party-id": "MCK",
      "x-correlation-id": command.id,
    });
    // Waits the CPO's timeout and a grace period for the CommandResult.
    expect(c).toMatchObject({
      holdRef: "hold-1",
      responseTimeoutS: 30,
      deadlineAt: new Date(
        T0.getTime() + 30_000 + RESULT_GRACE_MS,
      ).toISOString(),
    });

    await cpo.sendCommandResult("ACCEPTED");
    const done = await getCommand(command.id, DRIVER, deps());
    expect(done).toMatchObject({
      status: "succeeded",
      pending: false,
      result: "ACCEPTED",
      message: "The charger accepted the start.",
    });
    expect(releases).toEqual([]);
    expect(peers.auditLog.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "command.claim",
        "command.accepted",
        "command.succeeded",
      ]),
    );
    // The audit names the command, never the driver or the token.
    expect(JSON.stringify(peers.auditLog)).not.toContain(token.uid);
  });

  it("sends to the CPO whose location it is, when two CPOs use the same IDs", async () => {
    const { command } = await start({
      locationId: loc(two, "LOC1", cpo2.party),
    });
    expect(cpo.state.commands).toEqual([]);
    expect(cpo2.state.commands[0].headers).toMatchObject({
      "ocpi-to-country-code": "YY",
      "ocpi-to-party-id": "TWO",
    });
    await cpo2.sendCommandResult("ACCEPTED");
    expect((await stored(command.id)).status).toBe("succeeded");
    // The other CPO cannot answer for it.
    await expect(
      cpo.sendCommandResult("FAILED", { command: cpo2.state.commands[0] }),
    ).rejects.toMatchObject({ statusCode: 2000, httpStatus: 404 });
  });

  it("starts at a location without choosing an EVSE", async () => {
    await start({ evseUid: undefined, connectorId: undefined });
    expect(cpo.state.commands[0].body).not.toHaveProperty("evse_uid");
    expect(cpo.state.commands[0].body).not.toHaveProperty("connector_id");
  });

  const RESULT_STATUS: Record<CommandResultType, string> = {
    ACCEPTED: "succeeded",
    CANCELED_RESERVATION: "failed",
    EVSE_OCCUPIED: "failed",
    EVSE_INOPERATIVE: "failed",
    FAILED: "failed",
    NOT_SUPPORTED: "not_supported",
    REJECTED: "failed",
    TIMEOUT: "timed_out",
    UNKNOWN_RESERVATION: "failed",
  };

  it.each(COMMAND_RESULT_TYPES)(
    "handles the CommandResult %s, releasing the hold unless it started",
    async (result) => {
      const { command } = await start();
      const res = await cpo.sendCommandResult(result, {
        message: [{ language: "en", text: `Charger says ${result}` }],
      });
      expect(res.statusCode).toBe(1000);
      const view = (await getCommand(command.id, DRIVER, deps()))!;
      expect(view).toMatchObject({
        status: RESULT_STATUS[result],
        result,
        pending: false,
        peerMessage: `Charger says ${result}`,
      });
      expect(view.message).not.toBe("");
      expect(releases).toEqual(
        result === "ACCEPTED" ? [] : [{ id: command.id, uncertain: false }],
      );
      if (result === "NOT_SUPPORTED") {
        expect(view.message).toBe("This charger doesn't accept app starts.");
        expect(view.alternatives).toEqual(["RFID"]);
      }
      if (result === "EVSE_OCCUPIED")
        expect(view.message).toBe("This charger is in use.");
      // A second delivery of the same result changes nothing.
      await cpo.sendCommandResult("ACCEPTED");
      expect((await stored(command.id)).status).toBe(RESULT_STATUS[result]);
      expect(releases.length).toBe(result === "ACCEPTED" ? 0 : 1);
    },
  );

  it.each(["REJECTED", "NOT_SUPPORTED"] as const)(
    "treats a synchronous %s as 'doesn't accept app starts', releases the hold at once and suggests RFID",
    async (result) => {
      cpo.answerCommands({ result, timeout: 0 });
      const { command } = await start();
      expect(command).toMatchObject({
        status: "not_supported",
        pending: false,
        result,
        message: "This charger doesn't accept app starts.",
        alternatives: ["RFID"],
      });
      expect(releases).toEqual([{ id: command.id, uncertain: false }]);
      expect(events).toEqual([
        `hold:${command.id}`,
        "cpo:command",
        `release:${command.id}`,
      ]);
    },
  );

  it("suggests no other start method when the location data names none", async () => {
    const location = structuredClone(cpo.state.locations[0]);
    location.evses![0].capabilities = ["REMOTE_START_STOP_CAPABLE"];
    await locations.putLocation(
      one.id,
      location,
      T0.toISOString(),
      (await locations.getLocation({
        peerId: one.id,
        countryCode: "ZZ",
        partyId: "MCK",
        id: "LOC1",
      }))!.revision,
    );
    cpo.answerCommands({ result: "REJECTED", timeout: 0 });
    const { command } = await start();
    expect(command).toMatchObject({
      status: "not_supported",
      alternatives: [],
    });
  });

  it("ends a synchronous UNKNOWN_SESSION as failed", async () => {
    cpo.answerCommands({ result: "UNKNOWN_SESSION", timeout: 0 });
    const { command } = await start();
    expect(command).toMatchObject({
      status: "failed",
      result: "UNKNOWN_SESSION",
    });
    expect(releases).toHaveLength(1);
  });

  it("is not_supported without a hold or a request when the CPO has no Commands Receiver", async () => {
    await peers.updatePeer(one.id, {
      endpoints: one.endpoints.filter((e) => e.identifier !== "commands"),
    });
    const { command } = await start();
    expect(command).toMatchObject({
      status: "not_supported",
      alternatives: ["RFID"],
    });
    expect(events).toEqual([`release:${command.id}`]);
    expect(cpo.state.commands).toEqual([]);
  });

  it("handles a CommandResult that arrives before the CommandResponse", async () => {
    cpo.answerCommands({
      result: "ACCEPTED",
      timeout: 30,
      resultFirst: "EVSE_OCCUPIED",
    });
    const { command } = await start();
    expect(command).toMatchObject({
      status: "failed",
      result: "EVSE_OCCUPIED",
    });
    expect(await stored(command.id)).toMatchObject({
      responseResult: "ACCEPTED",
      responseTimeoutS: 30,
    });
    expect(releases).toHaveLength(1);
  });

  it("refuses bad input before claiming anything", async () => {
    const cases: [Promise<unknown>, string, number][] = [
      [start({ requestId: "short" }), "Request ID", 400],
      [start({ locationId: "nope" }), "Unknown location", 404],
      [start({ locationId: loc(one, "LOC404") }), "Unknown location", 404],
      [start({ evseUid: undefined }), "charger of this connector", 400],
      [start({ evseUid: "LOC1-9" }), "Unknown charger", 404],
      [start({ connectorId: "9" }), "Unknown connector", 404],
      [start({ driverRef: "nobody" }), "no app token", 403],
    ];
    for (const [p, message, status] of cases) {
      const e = (await p.catch((x: unknown) => x)) as CommandError;
      expect(e).toBeInstanceOf(CommandError);
      expect(e.message).toContain(message);
      expect(e.httpStatus).toBe(status);
    }
    // An unpublished site, and a removed EVSE (LOC5-4).
    const fleet = cpo.state.locations.find((l) => !l.publish)!;
    await expect(start({ locationId: loc(one, fleet.id) })).rejects.toThrow(
      "Unknown location",
    );
    await expect(
      start({ locationId: loc(one, "LOC5"), evseUid: "LOC5-4" }),
    ).rejects.toThrow("Unknown charger");
    expect(commands.commands.size).toBe(0);
    expect(cpo.state.commands).toEqual([]);
  });

  it("needs a connector where the EVSE says START_SESSION_CONNECTOR_ID_REQUIRED", async () => {
    const [location] = sampleLocations(cpo.party, 1);
    location.evses![0].capabilities!.push(
      "START_SESSION_CONNECTOR_ID_REQUIRED",
    );
    const held = await locations.getLocation({
      peerId: one.id,
      countryCode: "ZZ",
      partyId: "MCK",
      id: "LOC1",
    });
    await locations.putLocation(
      one.id,
      location,
      T0.toISOString(),
      held!.revision,
    );
    await expect(start({ connectorId: undefined })).rejects.toThrow(
      "Choose a connector",
    );
    await start();
    expect(cpo.state.commands).toHaveLength(1);
  });

  it("refuses a blocked app token, and a peer that is not registered", async () => {
    const token = (await tokens.listByDriver(DRIVER))[0];
    await blockToken(token.uid, "APP_USER", {
      tokens,
      peers,
      client,
      actor: "test",
    });
    await expect(start()).rejects.toMatchObject({ httpStatus: 403 });
    await peers.updatePeer(two.id, { status: "unregistered" });
    await expect(
      start({
        driverRef: "driver-2",
        locationId: loc(two, "LOC1", cpo2.party),
      }),
    ).rejects.toThrow("Unknown charging network");
    expect(cpo.state.commands.length + cpo2.state.commands.length).toBe(0);
  });
});

describe("one tap, one command", () => {
  it("returns the same command for the same request ID, and never sends it twice", async () => {
    const requestId = newRequestId();
    const first = await start({ requestId });
    const again = await start({ requestId });
    expect(again).toEqual({ state: "replayed", command: first.command });
    expect(cpo.state.commands).toHaveLength(1);
    // The same ID for another start is refused.
    await expect(start({ requestId, evseUid: "LOC1-2" })).rejects.toMatchObject(
      {
        httpStatus: 409,
        message: "This request ID was already used for another command.",
      },
    );
  });

  it("sends one command when the same tap arrives many times at once", async () => {
    const requestId = newRequestId();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => start({ requestId })),
    );
    expect(results.filter((r) => r.state === "created")).toHaveLength(1);
    expect(new Set(results.map((r) => r.command.id)).size).toBe(1);
    expect(cpo.state.commands).toHaveLength(1);
    expect(events.filter((e) => e.startsWith("hold:"))).toHaveLength(1);
  });

  it("ends an open start past its deadline when the driver taps again", async () => {
    // A claim whose server stopped before sending: nothing went out.
    const stale = await commands.claim({
      type: "START_SESSION",
      driverRef: DRIVER,
      requestId: newRequestId(),
      peerId: one.id,
      toCountryCode: "ZZ",
      toPartyId: "MCK",
      locationId: "LOC1",
      evseUid: null,
      connectorId: null,
      sessionId: null,
      authorizationReference: "ref-stale",
      deadlineAt: T0.toISOString(),
    });
    const { state } = await start();
    expect(state).toBe("created");
    expect(await stored(stale.command.id)).toMatchObject({
      status: "failed",
      error: "Not sent: it stopped before the request went out",
    });
    expect(releases[0]).toEqual({ id: stale.command.id, uncertain: false });
    expect(cpo.state.commands).toHaveLength(1);
  });

  it("keeps a second start of the driver waiting while one is open, then allows it", async () => {
    const first = await start();
    const second = await start();
    expect(second.state).toBe("busy");
    expect(second.command.id).toBe(first.command.id);
    expect(cpo.state.commands).toHaveLength(1);
    // Another driver is not held up.
    expect((await start({ driverRef: "driver-2" })).state).toBe("created");
    await cpo.sendCommandResult("FAILED", { command: cpo.state.commands[0] });
    expect((await start()).state).toBe("created");
    expect(cpo.state.commands).toHaveLength(3);
  });
});

describe("an unknown outcome", () => {
  it("waits on a timeout without resending, takes a late CommandResult, and never sends again on retry", async () => {
    cpo.answerCommands("hang");
    const requestId = newRequestId();
    const { command } = await start({ requestId });
    expect(command).toMatchObject({ status: "sending", pending: true });
    expect(await stored(command.id)).toMatchObject({
      outcomeUncertain: true,
      deadlineAt: new Date(T0.getTime() + UNCERTAIN_WAIT_MS).toISOString(),
    });
    expect((await stored(command.id)).error).toContain("timed out");
    // A retry of the tap, or a new tap, sends nothing.
    expect((await start({ requestId })).state).toBe("replayed");
    expect((await start()).state).toBe("busy");
    expect(cpo.state.commands).toHaveLength(1);
    // The charger did start: the CPO's CommandResult settles it.
    await cpo.sendCommandResult("ACCEPTED");
    expect((await stored(command.id)).status).toBe("succeeded");
    expect(releases).toEqual([]);
  });

  it.each([
    ["an HTTP 503", () => cpo.failNext(1, 503)],
    [
      "an answer without a CommandResponse",
      () => cpo.answerCommands({ result: "MAYBE", timeout: 1 } as never),
    ],
  ])("stays open after %s", async (_, fault) => {
    fault();
    const { command } = await start();
    expect(command.status).toBe("sending");
    expect((await stored(command.id)).outcomeUncertain).toBe(true);
    expect(releases).toEqual([]);
  });

  it("times out to a clear state at its deadline and releases the hold, marked uncertain", async () => {
    cpo.answerCommands("hang");
    const { command } = await start();
    clock = new Date(T0.getTime() + UNCERTAIN_WAIT_MS - 1000);
    expect((await getCommand(command.id, DRIVER, deps()))!.status).toBe(
      "sending",
    );
    clock = new Date(T0.getTime() + UNCERTAIN_WAIT_MS);
    expect(await getCommand(command.id, DRIVER, deps())).toMatchObject({
      status: "timed_out",
      pending: false,
      message:
        "No answer from the charger. Check the charger before you try again.",
    });
    expect(releases).toEqual([{ id: command.id, uncertain: true }]);
    // A late CommandResult is recorded, the state stays, the hold is not touched again.
    await cpo.sendCommandResult("ACCEPTED");
    expect(await stored(command.id)).toMatchObject({
      status: "timed_out",
      lateResult: "ACCEPTED",
    });
    expect(releases).toHaveLength(1);
    expect(peers.auditLog.at(-1)?.action).toBe("command.late_result");
    // Now a new start may go out.
    cpo.answerCommands({ result: "ACCEPTED", timeout: 30 });
    expect((await start()).state).toBe("created");
  });

  it("times out an accepted command after the CPO's timeout and grace, from the cron sweep", async () => {
    cpo.answerCommands({ result: "ACCEPTED", timeout: 20 });
    const { command } = await start();
    clock = new Date(T0.getTime() + 20_000 + RESULT_GRACE_MS);
    expect(await expireCommands(deps())).toBe(1);
    expect((await stored(command.id)).status).toBe("timed_out");
    expect(await expireCommands(deps())).toBe(0);
  });

  it("ends as failed, at once, when the CPO refuses the request with an OCPI error", async () => {
    vi.spyOn(cpo, "handle").mockImplementationOnce(async () =>
      Response.json(
        {
          status_code: 2001,
          status_message: "Invalid or missing parameters",
          timestamp: "2026-10-21T10:00:00Z",
        },
        { status: 400 },
      ),
    );
    const { command } = await start();
    expect(command).toMatchObject({
      status: "failed",
      message: "The charging network refused the request. Try again later.",
    });
    expect(releases).toEqual([{ id: command.id, uncertain: false }]);
  });
});

describe("the pre-authorization hook", () => {
  it("sends nothing when the hold is refused", async () => {
    nextHold = {
      ok: false,
      reason: "Your card was declined. Use another card.",
    };
    const { command } = await start();
    expect(command).toMatchObject({
      status: "hold_failed",
      message: "Your card was declined. Use another card.",
    });
    expect(cpo.state.commands).toEqual([]);
  });

  it("sends nothing, and releases, when the hold fails", async () => {
    nextHold = new Error("payment provider down");
    const { command } = await start();
    expect(command).toMatchObject({
      status: "hold_failed",
      message: "The payment check failed. Try again.",
    });
    expect(cpo.state.commands).toEqual([]);
    expect(releases).toEqual([{ id: command.id, uncertain: false }]);
  });

  it("never sends a start whose hold outlasted its claim, and releases that hold", async () => {
    let finishHold!: () => void;
    setPreAuthForTests({
      hold: () =>
        new Promise<HoldResult>((resolve) => {
          finishHold = () => resolve({ ok: true, reference: "hold-late" });
        }),
      async release(c, why) {
        releases.push({ id: c.id, uncertain: why.uncertain });
        events.push(`release:${c.holdRef}`);
      },
    });
    const pending = start();
    await vi.waitFor(() => expect(finishHold).toBeDefined());
    clock = new Date(T0.getTime() + CLAIM_TTL_MS);
    expect(await expireCommands(deps())).toBe(1);
    finishHold();
    const { command } = await pending;
    expect(command.status).toBe("failed");
    expect(cpo.state.commands).toEqual([]);
    expect(events).toEqual(["release:null", "release:hold-late"]);
  });
});

describe("our CommandResult endpoint", () => {
  const post = (
    url: string,
    body: unknown,
    peerToken = cpo.state.emsp!.token,
  ) =>
    ocpiRequest(
      {
        method: "POST",
        url,
        token: peerToken,
        body,
        routing: {
          from: cpo.party,
          to: { countryCode: "NL", partyId: "ABC" },
        },
      },
      { transport: net.transport, retries: 0 },
    );

  it("refuses unknown commands, the wrong module path, bad bodies and unknown peers", async () => {
    const { command } = await start();
    const url = `${EMSP}/commands/START_SESSION/${command.id}`;
    await expect(post(url, { result: "SOMETIMES" })).rejects.toMatchObject({
      statusCode: 2001,
    });
    await expect(
      post(`${EMSP}/commands/STOP_SESSION/${command.id}`, {
        result: "ACCEPTED",
      }),
    ).rejects.toMatchObject({ statusCode: 2000, httpStatus: 404 });
    await expect(
      post(
        `${EMSP}/commands/START_SESSION/00000000-0000-4000-8000-000000000000`,
        {
          result: "ACCEPTED",
        },
      ),
    ).rejects.toMatchObject({ statusCode: 2000, httpStatus: 404 });
    await expect(
      post(url, { result: "ACCEPTED" }, "not-a-token"),
    ).rejects.toMatchObject({ httpStatus: 401 });
    expect((await stored(command.id)).status).toBe("accepted");
    expect((await post(url, { result: "ACCEPTED" })).statusCode).toBe(1000);
    expect((await stored(command.id)).status).toBe("succeeded");
  });

  it("does not take a result for a command that was never sent", async () => {
    const c = (
      await commands.claim({
        type: "START_SESSION",
        driverRef: DRIVER,
        requestId: newRequestId(),
        peerId: one.id,
        toCountryCode: "ZZ",
        toPartyId: "MCK",
        locationId: "LOC1",
        evseUid: null,
        connectorId: null,
        sessionId: null,
        authorizationReference: "ref-claimed",
        deadlineAt: T0.toISOString(),
      })
    ).command;
    await expect(
      post(`${EMSP}/commands/START_SESSION/${c.id}`, { result: "ACCEPTED" }),
    ).rejects.toMatchObject({ statusCode: 2000 });
    // Directly too: only open commands take a result.
    expect(
      (await applyCommandResult(c, { result: "ACCEPTED" }, deps())).status,
    ).toBe("claimed");
  });
});

describe("STOP_SESSION", () => {
  /** A started session of the driver, linked as the Sessions module will. */
  async function running(driverRef = DRIVER, sessionId = "SESSION-1") {
    const { command } = await start({ driverRef });
    await cpo.sendCommandResult("ACCEPTED");
    const c = await stored(command.id);
    expect(
      await linkSession(
        {
          peerId: one.id,
          authorizationReference: c.authorizationReference!,
          sessionId,
        },
        deps(),
      ),
    ).toBe(true);
    return sessionId;
  }

  const stop = (over: Partial<Parameters<typeof stopSession>[0]> = {}) =>
    stopSession(
      {
        driverRef: DRIVER,
        requestId: newRequestId(),
        peerId: one.id,
        sessionId: "SESSION-1",
        ...over,
      },
      deps(),
    );

  it("stops the driver's own session with a valid StopSession", async () => {
    await running();
    const { state, command } = await stop();
    expect(state).toBe("created");
    expect(command.status).toBe("accepted");
    const sent = cpo.state.commands.at(-1)!;
    expect(sent).toMatchObject({
      type: "STOP_SESSION",
      body: {
        response_url: `${EMSP}/commands/STOP_SESSION/${command.id}`,
        session_id: "SESSION-1",
      },
    });
    expect(sent.headers["ocpi-to-party-id"]).toBe("MCK");
    await cpo.sendCommandResult("ACCEPTED");
    expect(await getCommand(command.id, DRIVER, deps())).toMatchObject({
      status: "succeeded",
      message: "The charger accepted the stop.",
    });
    // A stop holds nothing and releases nothing.
    expect(events.filter((e) => e.startsWith("hold:"))).toHaveLength(1);
    expect(releases).toEqual([]);
  });

  it("never stops another driver's session, or a session it cannot name", async () => {
    await running("driver-2", "SESSION-2");
    for (const over of [
      { sessionId: "SESSION-2" },
      { sessionId: "SESSION-404" },
      { sessionId: "SESSION-2", peerId: two.id },
    ])
      await expect(stop(over)).rejects.toMatchObject({
        httpStatus: 404,
        message: "No such session.",
      });
    expect(cpo.state.commands.filter((c) => c.type === "STOP_SESSION")).toEqual(
      [],
    );
    // A link belongs to one session, of the peer that ran it.
    const start2 = [...commands.commands.values()].find(
      (c) => c.sessionId === "SESSION-2",
    )!;
    for (const input of [
      { peerId: one.id, sessionId: "OTHER" },
      { peerId: two.id, sessionId: "SESSION-2" },
    ])
      expect(
        await linkSession(
          { ...input, authorizationReference: start2.authorizationReference! },
          deps(),
        ),
      ).toBe(false);
  });

  it("sends one stop per session at a time, and one per request ID", async () => {
    await running();
    const requestId = newRequestId();
    const first = await stop({ requestId });
    expect((await stop({ requestId })).state).toBe("replayed");
    expect((await stop()).state).toBe("busy");
    expect(
      cpo.state.commands.filter((c) => c.type === "STOP_SESSION"),
    ).toHaveLength(1);
    await expect(
      stop({ requestId, sessionId: "SESSION-9" }),
    ).rejects.toMatchObject({ httpStatus: 404 });
    expect(first.command.pending).toBe(true);
  });

  it.each([
    ["UNKNOWN_SESSION", "failed", "doesn't know this session"],
    ["REJECTED", "failed", "refused the request"],
    ["NOT_SUPPORTED", "not_supported", "doesn't accept app stops"],
  ] as const)("handles a synchronous %s", async (result, status, message) => {
    await running();
    cpo.answerCommands({ result, timeout: 0 });
    const { command } = await stop();
    expect(command).toMatchObject({ status, result, alternatives: [] });
    expect(command.message).toContain(message);
    expect(releases).toEqual([]);
  });

  it("keeps an unknown outcome open and never resends it", async () => {
    await running();
    cpo.answerCommands("hang");
    const { command } = await stop();
    expect(command.status).toBe("sending");
    expect((await stop()).state).toBe("busy");
    clock = new Date(clock.getTime() + UNCERTAIN_WAIT_MS);
    expect(await getCommand(command.id, DRIVER, deps())).toMatchObject({
      status: "timed_out",
      message:
        "No answer from the charger. Check whether it is still charging before you try again.",
    });
    expect(
      cpo.state.commands.filter((c) => c.type === "STOP_SESSION"),
    ).toHaveLength(1);
  });
});

describe("reading commands", () => {
  it("shows a driver only their own commands", async () => {
    const { command } = await start();
    expect(await getCommand(command.id, "driver-2", deps())).toBeNull();
    expect(await getCommand("not-a-uuid", DRIVER, deps())).toBeNull();
    expect((await getCommand(command.id, DRIVER, deps()))!.id).toBe(command.id);
  });
});

describe("demo mode", () => {
  it("accepts a start for the demo CPO at once, labelled, and sends nothing", async () => {
    uninstallNetwork();
    const fetchSpy = vi.fn(() => {
      throw new Error("demo mode must not call fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
    process.env.DEMO_MODE = "true";
    const demoLocations = new MemoryLocationStore();
    await demoLocations.saveLocations(
      DEMO_PEER_ID,
      sampleLocations({ countryCode: "ZZ", partyId: "MCK" }, 1),
      T0.toISOString(),
    );
    const before = net.calls.length;
    const { command } = await startSession(
      {
        driverRef: DRIVER,
        requestId: newRequestId(),
        locationId: locationAppId({
          peerId: DEMO_PEER_ID,
          countryCode: "ZZ",
          partyId: "MCK",
          id: "LOC1",
        }),
        evseUid: "LOC1-1",
      },
      deps({ locations: demoLocations }),
    );
    expect(command).toMatchObject({
      status: "succeeded",
      peerMessage: "Demo mode: nothing was sent to a charger.",
    });
    // A real peer's location is refused in demo mode: nothing reaches a CPO.
    await expect(start()).rejects.toThrow("Unknown charging network");
    expect(net.calls.length).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cpo.state.commands).toEqual([]);
  });
});
