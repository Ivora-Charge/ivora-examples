import "server-only";
import { randomUUID } from "node:crypto";
import { DEMO_PEER_ID } from "@/lib/locations/registry";
import { parseLocationAppId } from "@/lib/locations/search";
import type { LocationStore } from "@/lib/locations/store";
import { ocpiRequest, type ClientOptions } from "@/lib/ocpi/client";
import {
  parseCommandResponse,
  type CommandResponse,
  type CommandResponseType,
  type CommandResult,
  type CommandResultType,
  type StartSession,
  type StopSession,
} from "@/lib/ocpi/command-objects";
import {
  OcpiClientError,
  OcpiError,
  OcpiUnauthorizedError,
} from "@/lib/ocpi/errors";
import { ourParty } from "@/lib/ocpi/identity";
import { sameId, type DisplayText, type Evse } from "@/lib/ocpi/locations";
import type { Peer, PeerStore } from "@/lib/ocpi/store";
import { decryptToken } from "@/lib/ocpi/tokens";
import type { Party } from "@/lib/ocpi/types";
import { ocpiUrls } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { toOcpiToken, tokenValid } from "@/lib/tokens/push";
import type { TokenStore } from "@/lib/tokens/store";
import { preAuth, type HoldResult, type PreAuth } from "./pre-auth";
import {
  FINAL_STATUSES,
  OPEN_STATUSES,
  type Command,
  type CommandKind,
  type CommandPatch,
  type CommandStatus,
  type CommandStore,
  type FinalStatus,
  type NewCommand,
} from "./store";

/**
 * Sending START_SESSION and STOP_SESSION to a CPO's Commands Receiver (OCPI 2.2.1
 * section 13), for a driver:
 *
 *   POST {receiver}/START_SESSION   StartSession: response_url, token, location_id,
 *                                   evse_uid, connector_id, authorization_reference
 *   POST {receiver}/STOP_SESSION    StopSession: response_url, session_id
 *
 * The CPO answers at once with a CommandResponse (ACCEPTED, REJECTED, UNKNOWN_SESSION,
 * NOT_SUPPORTED, and how long it waits for the charger), then POSTs a CommandResult to
 * our response_url (receiver.ts).
 *
 * - One command per app request ID: the request is claimed in the database first, and
 *   the same request ID again returns that command without sending anything. While a
 *   driver's start (or a session's stop) is open, another request returns it as `busy`.
 * - A start is sent only after the payment hold succeeds (pre-auth.ts), and the hold is
 *   released as soon as the start ends without charging.
 * - A request whose outcome is unknown (a timeout, an HTTP 5xx, no CommandResponse) is
 *   never sent again, under any ID: it waits for the CommandResult, or its deadline,
 *   then ends as `timed_out`.
 * - A CPO that refuses app starts (REJECTED or NOT_SUPPORTED at once, a NOT_SUPPORTED
 *   result, or no Commands Receiver at all) ends the start as `not_supported`, with
 *   the charger's own start methods where its location data names them.
 * - A stop names the CPO's session, and must be one of the driver's own sessions.
 *
 * Demo mode sends nothing: a command for the demo CPO is accepted at once, labelled.
 */
export type CommandDeps = {
  commands: CommandStore;
  peers: PeerStore;
  tokens: TokenStore;
  locations: LocationStore;
  /** The payment hold before a start. Default: preAuth(), the stub until part 7. */
  preAuth?: PreAuth;
  /** Whose session a CPO session is. Default: the driver whose start it links to. */
  sessionOwner?: SessionOwner;
  client?: ClientOptions;
  now?: () => Date;
  /** For the audit log. Default "app". */
  actor?: string;
};

/** The driver a CPO's session belongs to, and the CPO party it runs at. */
export type SessionOwner = (
  peerId: string,
  sessionId: string,
  deps: CommandDeps,
) => Promise<{ driverRef: string; party: Party } | null>;

/** A refusal the driver may see. Never carries a token, peer data or another driver's. */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

/** How a driver may start at a charger that refuses app starts. */
export type StartMethod = "RFID";

export type CommandView = {
  id: string;
  type: CommandKind;
  requestId: string;
  status: CommandStatus;
  /** True until the command ends: poll until it is false. */
  pending: boolean;
  /** The CommandResult, else the CommandResponse that ended it. */
  result: CommandResultType | CommandResponseType | null;
  /** For the driver, in English. */
  message: string;
  /** The CPO's own message, when it gave one. */
  peerMessage: string | null;
  /** For a start the charger refuses from the app: other ways to start there. */
  alternatives: StartMethod[];
  sessionId: string | null;
  createdAt: string;
  deadlineAt: string;
  finishedAt: string | null;
};

/**
 * - `created`: sent (or settled) now.
 * - `replayed`: this request ID was used before; nothing was sent again.
 * - `busy`: another start of this driver (or stop of this session) is still open.
 */
export type CommandOutcome = {
  state: "created" | "replayed" | "busy";
  command: CommandView;
};

/** How long a claimed command may wait for its payment hold before it ends unsent. */
export const CLAIM_TTL_MS = 2 * 60_000;
/** How long a command whose CommandResponse never arrived waits for its CommandResult. */
export const UNCERTAIN_WAIT_MS = 3 * 60_000;
/** Added to the CPO's timeout, for its CommandResult to reach us. */
export const RESULT_GRACE_MS = 60_000;
/** The longest CPO timeout we wait for. */
export const MAX_RESPONSE_TIMEOUT_S = 600;

/** One attempt, never retried: a command repeated is a second command. */
const COMMAND_CLIENT: ClientOptions = { timeoutMs: 15_000, retries: 0 };

const DRIVER_REF = /^[\x21-\x7e]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/;
/** CiString(36). */
const OCPI_ID = /^[\x21-\x7e]{1,36}$/;

const nowOf = (deps: CommandDeps) => deps.now?.() ?? new Date();
const later = (now: Date, ms: number) =>
  new Date(now.getTime() + ms).toISOString();

function driverRef(input: string): string {
  const ref = input.trim();
  if (!DRIVER_REF.test(ref)) throw new CommandError("Invalid driver.");
  return ref;
}

function requestId(input: string): string {
  const id = input.trim();
  if (!REQUEST_ID.test(id))
    throw new CommandError(
      "Request ID must be 8 to 64 letters, digits or . _ : - (a UUID, say).",
    );
  return id;
}

const optionalId = (v: string | undefined) => v?.trim() || undefined;

async function audit(
  deps: CommandDeps,
  action: string,
  c: Command,
  details: Record<string, unknown> = {},
) {
  try {
    await deps.peers.audit({
      actor: deps.actor ?? "app",
      action,
      subjectId: c.id,
      // subjectId names the command; the details never repeat the driver or token.
      details: {
        type: c.type,
        peer_id: c.peerId,
        status: c.status,
        ...details,
      },
    });
  } catch (e) {
    // A command may already be on its way to a charger: never fail it over the log.
    console.error(
      `Audit of command ${c.id} failed: ${e instanceof Error ? e.name : "unknown error"}`,
    );
  }
}

/** The peer's commands Receiver URL, if it has one. */
export function commandsReceiver(peer: Peer): string | undefined {
  return peer.endpoints.find(
    (e) => e.identifier === "commands" && e.role === "RECEIVER",
  )?.url;
}

/** Our response_url for a command: the CPO POSTs its CommandResult there. */
export function responseUrl(c: Pick<Command, "id" | "type">): string {
  return `${ocpiUrls().commands}/${c.type}/${c.id}`;
}

/**
 * The registered peer a command goes to. Null in demo mode, where the only peer is the
 * built-in mock CPO and nothing is sent.
 */
async function commandPeer(
  peerId: string,
  deps: CommandDeps,
): Promise<Peer | null> {
  if (isDemo()) {
    if (peerId !== DEMO_PEER_ID)
      throw new CommandError("Unknown charging network.", 404);
    return null;
  }
  const peer = await deps.peers.getPeer(peerId);
  if (!peer || peer.status !== "registered" || !peer.tokenCiphertext)
    throw new CommandError("Unknown charging network.", 404);
  return peer;
}

const STOPPED_OK = "The charger accepted the stop.";
const RESULT_TEXT: Record<CommandResultType, string> = {
  ACCEPTED: "The charger accepted the start.",
  CANCELED_RESERVATION: "The charger cancelled a reservation instead.",
  EVSE_OCCUPIED: "This charger is in use.",
  EVSE_INOPERATIVE: "This charger is out of order.",
  FAILED: "The charger could not do it. Try again, or try another charger.",
  NOT_SUPPORTED: "This charger doesn't accept app starts.",
  REJECTED: "The charger refused.",
  TIMEOUT: "The charger didn't answer. Check the charger before you try again.",
  UNKNOWN_RESERVATION: "The charger doesn't know this reservation.",
};

/** What the driver is told. */
function message(c: Command): string {
  const start = c.type === "START_SESSION";
  switch (c.status) {
    case "claimed":
    case "sending":
    case "accepted":
      return "Waiting for the charger…";
    case "succeeded":
      return start ? RESULT_TEXT.ACCEPTED : STOPPED_OK;
    case "not_supported":
      return start
        ? "This charger doesn't accept app starts."
        : "This charger doesn't accept app stops. Stop at the charger, or unplug if your car allows it.";
    case "hold_failed":
      return c.error || "Your payment method could not be authorised.";
    case "timed_out":
      return start
        ? "No answer from the charger. Check the charger before you try again."
        : "No answer from the charger. Check whether it is still charging before you try again.";
    case "failed":
      if (c.result && c.result !== "ACCEPTED") return RESULT_TEXT[c.result];
      if (c.responseResult === "UNKNOWN_SESSION")
        return "The charging network doesn't know this session; it may have ended already.";
      return "The charging network refused the request. Try again later.";
  }
}

/** The charger's own ways to start, from its location data. */
async function alternatives(
  c: Command,
  deps: CommandDeps,
): Promise<StartMethod[]> {
  if (c.type !== "START_SESSION" || c.status !== "not_supported") return [];
  const held = await deps.locations.getLocation({
    peerId: c.peerId,
    countryCode: c.toCountryCode,
    partyId: c.toPartyId,
    id: c.locationId!,
  });
  const evses = (held?.location.evses ?? []).filter(
    (e) => e.status !== "REMOVED" && (!c.evseUid || sameId(e.uid, c.evseUid)),
  );
  // OCPI 2.2.1 has no capability for Plug & Charge (ISO 15118); RFID is all it says.
  return evses.some((e) => e.capabilities?.includes("RFID_READER"))
    ? ["RFID"]
    : [];
}

export async function viewCommand(
  c: Command,
  deps: CommandDeps,
): Promise<CommandView> {
  return {
    id: c.id,
    type: c.type,
    requestId: c.requestId,
    status: c.status,
    pending: (OPEN_STATUSES as readonly string[]).includes(c.status),
    result: c.result ?? c.responseResult,
    message: message(c),
    peerMessage: c.peerMessage || null,
    alternatives: await alternatives(c, deps),
    sessionId: c.sessionId,
    createdAt: c.createdAt,
    deadlineAt: c.deadlineAt,
    finishedAt: c.finishedAt,
  };
}

/** The CPO's message for the driver: English if given, else the first; one line. */
export function peerText(texts: DisplayText[] | undefined): string {
  const t = texts?.find((m) => m.language === "en") ?? texts?.[0];
  return (t?.text ?? "")
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .trim()
    .slice(0, 300);
}

const errorText = (e: unknown) =>
  e instanceof OcpiError
    ? e.message.slice(0, 300)
    : "Not sent: unexpected error";

/**
 * Ends an open command with `status`, if it is still in one of `from`; null when
 * another change got there first. A start that ends without charging releases its
 * payment hold here, once per command, by whichever change ended it.
 */
async function finish(
  c: Command,
  from: readonly CommandStatus[],
  status: FinalStatus,
  patch: CommandPatch,
  deps: CommandDeps,
): Promise<Command | null> {
  const now = nowOf(deps).toISOString();
  const done = await deps.commands.transition(
    c.id,
    from,
    { ...patch, status, finishedAt: now },
    now,
  );
  if (!done) return null;
  await audit(deps, `command.${status}`, done, {
    result: done.result,
    response_result: done.responseResult,
    outcome_uncertain: done.outcomeUncertain,
  });
  if (done.type === "START_SESSION" && status !== "succeeded")
    await release(done, deps, {
      // Our own deadline, without any CommandResult: a session may still appear.
      uncertain: status === "timed_out" && done.result === null,
    });
  return done;
}

async function release(
  c: Command,
  deps: CommandDeps,
  why: { uncertain: boolean },
) {
  try {
    await (deps.preAuth ?? preAuth()).release(c, why);
  } catch (e) {
    console.error(
      `Releasing the payment hold of command ${c.id} failed: ${e instanceof Error ? e.name : "unknown error"}`,
    );
    await audit(deps, "command.release_failed", c);
  }
}

/** The current version, after a compare-and-swap lost to another change. */
async function reread(id: string, deps: CommandDeps): Promise<Command> {
  const c = await deps.commands.get(id);
  if (!c) throw new Error("Command disappeared");
  return c;
}

/** What a CommandResponse that is not ACCEPTED means for the command. */
function responseStatus(
  type: CommandKind,
  r: Exclude<CommandResponseType, "ACCEPTED">,
): FinalStatus {
  // Some CPOs switch remote starts off and answer REJECTED: that is "not from the
  // app", not an error.
  if (type === "START_SESSION" && r === "REJECTED") return "not_supported";
  return r === "NOT_SUPPORTED" ? "not_supported" : "failed";
}

/** What a CommandResult means for the command. */
export function resultStatus(r: CommandResultType): FinalStatus {
  if (r === "ACCEPTED") return "succeeded";
  if (r === "NOT_SUPPORTED") return "not_supported";
  if (r === "TIMEOUT") return "timed_out";
  return "failed";
}

/** Applies the CPO's CommandResponse to a command that was sending. */
async function applyResponse(
  c: Command,
  response: CommandResponse,
  deps: CommandDeps,
): Promise<Command> {
  const now = nowOf(deps);
  const fields = {
    responseResult: response.result,
    responseTimeoutS: response.timeout,
  };
  const peerMessage = peerText(response.message);
  if (response.result === "ACCEPTED") {
    const waitS = Math.min(
      MAX_RESPONSE_TIMEOUT_S,
      Math.max(1, response.timeout),
    );
    const accepted = await deps.commands.transition(
      c.id,
      ["sending"],
      {
        ...fields,
        status: "accepted",
        peerMessage,
        deadlineAt: later(now, waitS * 1000 + RESULT_GRACE_MS),
      },
      now.toISOString(),
    );
    if (accepted) {
      await audit(deps, "command.accepted", accepted, {
        timeout_s: response.timeout,
      });
      return accepted;
    }
  } else {
    const done = await finish(
      c,
      ["sending"],
      responseStatus(c.type, response.result),
      { ...fields, peerMessage },
      deps,
    );
    if (done) return done;
  }
  // The CommandResult (or the deadline) got there first: keep its outcome, and note
  // the response.
  return (
    (await deps.commands.transition(
      c.id,
      FINAL_STATUSES,
      fields,
      now.toISOString(),
    )) ?? reread(c.id, deps)
  );
}

/**
 * Sends a command that is `sending`, once, and applies the answer. Demo mode sends
 * nothing and accepts it.
 */
async function send(
  c: Command,
  body: StartSession | StopSession,
  peer: Peer | null,
  deps: CommandDeps,
): Promise<Command> {
  if (!peer) {
    // Demo mode (commandPeer): the built-in mock CPO, never contacted.
    return (
      (await finish(
        c,
        ["sending"],
        "succeeded",
        {
          responseResult: "ACCEPTED",
          responseTimeoutS: 0,
          result: "ACCEPTED",
          peerMessage: "Demo mode: nothing was sent to a charger.",
        },
        deps,
      )) ?? reread(c.id, deps)
    );
  }
  const receiver = commandsReceiver(peer)!;
  let response: CommandResponse | undefined;
  let error = "";
  let definitive = false;
  try {
    const res = await ocpiRequest(
      {
        method: "POST",
        url: `${receiver.replace(/\/+$/, "")}/${c.type}`,
        token: decryptToken(peer.tokenCiphertext!, peer.id),
        body,
        routing: {
          from: ourParty(),
          to: { countryCode: c.toCountryCode, partyId: c.toPartyId },
        },
        // One correlation ID per command, so both sides' logs line up.
        correlationId: c.id,
      },
      deps.client ?? COMMAND_CLIENT,
    );
    const parsed = parseCommandResponse(res.data);
    if (parsed.ok) response = parsed.value;
    else
      error = `POST ${new URL(receiver).host} answered without a valid CommandResponse`;
  } catch (e) {
    error = errorText(e);
    // The CPO refused the request (an OCPI 2xxx, or our token): it was not forwarded.
    // Anything thrown before a request goes out is not an OcpiError. Timeouts, network
    // errors, 5xx, 3xxx and 4xxx (a hub) may have reached the charger: uncertain.
    definitive =
      e instanceof OcpiClientError ||
      e instanceof OcpiUnauthorizedError ||
      !(e instanceof OcpiError);
    console.error(
      `Command ${c.id} to peer ${peer.id}: ${e instanceof Error ? e.name : "unknown error"}`,
    );
  }
  if (response) return applyResponse(c, response, deps);
  if (definitive)
    return (
      (await finish(c, ["sending"], "failed", { error }, deps)) ??
      reread(c.id, deps)
    );
  // Unknown outcome: never resend. Wait for the CommandResult or the deadline.
  const now = nowOf(deps).toISOString();
  const waiting = await deps.commands.transition(
    c.id,
    ["sending"],
    { outcomeUncertain: true, error },
    now,
  );
  if (waiting) await audit(deps, "command.uncertain", waiting);
  return waiting ?? reread(c.id, deps);
}

/** Claims a command, or returns the one this request (or an open one) already has. */
async function claim(
  input: NewCommand,
  same: (held: Command) => boolean,
  deps: CommandDeps,
): Promise<{ done: CommandOutcome } | { done?: undefined; command: Command }> {
  let { outcome, command } = await deps.commands.claim(input);
  if (outcome === "busy" && overdue(command, nowOf(deps))) {
    // The open command is past its deadline (its server stopped, say): end it, then
    // claim again rather than wait for the sweep.
    await expire(command, deps);
    ({ outcome, command } = await deps.commands.claim(input));
  }
  if (outcome === "replayed" && !same(command))
    throw new CommandError(
      "This request ID was already used for another command.",
      409,
    );
  if (outcome !== "created")
    return {
      done: { state: outcome, command: await viewCommand(command, deps) },
    };
  await audit(deps, "command.claim", command, {
    location_id: command.locationId,
    evse_uid: command.evseUid,
    connector_id: command.connectorId,
  });
  return { command };
}

/**
 * Starts a session for a driver at a location (the app's location ID), optionally at
 * one EVSE and connector, with the driver's app token. `requestId` is the app's: the
 * same one again returns this command and sends nothing.
 */
export async function startSession(
  input: {
    driverRef: string;
    requestId: string;
    locationId: string;
    evseUid?: string;
    connectorId?: string;
  },
  deps: CommandDeps,
): Promise<CommandOutcome> {
  const ref = driverRef(input.driverRef);
  const reqId = requestId(input.requestId);
  const key = parseLocationAppId(input.locationId.trim());
  if (!key) throw new CommandError("Unknown location.", 404);
  const peer = await commandPeer(key.peerId, deps);
  const location = (await deps.locations.getLocation(key))?.location;
  if (!location?.publish) throw new CommandError("Unknown location.", 404);

  const evseUid = optionalId(input.evseUid);
  const connectorId = optionalId(input.connectorId);
  if (connectorId && !evseUid)
    throw new CommandError("Choose the charger of this connector too.");
  let evse: Evse | undefined;
  if (evseUid) {
    evse = location.evses?.find(
      (e) => sameId(e.uid, evseUid) && e.status !== "REMOVED",
    );
    if (!evse) throw new CommandError("Unknown charger.", 404);
  }
  const connector = connectorId
    ? evse!.connectors.find((x) => sameId(x.id, connectorId))
    : undefined;
  if (connectorId && !connector)
    throw new CommandError("Unknown connector.", 404);
  if (
    evse?.capabilities?.includes("START_SESSION_CONNECTOR_ID_REQUIRED") &&
    !connector
  )
    throw new CommandError("Choose a connector of this charger.");

  const now = nowOf(deps);
  const token = (await deps.tokens.listByDriver(ref)).find(
    (t) => t.type === "APP_USER",
  );
  if (!token) throw new CommandError("This driver has no app token.", 403);
  if (!tokenValid(token, now))
    throw new CommandError(
      "This driver's app token is blocked or expired.",
      403,
    );

  const claimed = await claim(
    {
      type: "START_SESSION",
      driverRef: ref,
      requestId: reqId,
      peerId: key.peerId,
      toCountryCode: location.country_code,
      toPartyId: location.party_id,
      locationId: location.id,
      evseUid: evse?.uid ?? null,
      connectorId: connector?.id ?? null,
      sessionId: null,
      authorizationReference: randomUUID(),
      deadlineAt: later(now, CLAIM_TTL_MS),
    },
    (held) =>
      held.peerId === key.peerId &&
      held.locationId === location.id &&
      held.evseUid === (evse?.uid ?? null) &&
      held.connectorId === (connector?.id ?? null),
    deps,
  );
  if (claimed.done) return claimed.done;
  const c = claimed.command;
  const done = (x: Command): Promise<CommandOutcome> =>
    viewCommand(x, deps).then((command) => ({ state: "created", command }));

  // A CPO without a Commands Receiver takes no app starts: no hold, nothing sent.
  if (peer && !commandsReceiver(peer))
    return done(
      (await finish(
        c,
        ["claimed"],
        "not_supported",
        { error: "This CPO offers no Commands Receiver" },
        deps,
      )) ?? (await reread(c.id, deps)),
    );

  let hold: HoldResult;
  try {
    hold = await (deps.preAuth ?? preAuth()).hold(c);
  } catch (e) {
    console.error(
      `Payment hold for command ${c.id} failed: ${e instanceof Error ? e.name : "unknown error"}`,
    );
    hold = { ok: false, reason: "The payment check failed. Try again." };
  }
  if (!hold.ok)
    return done(
      (await finish(
        c,
        ["claimed"],
        "hold_failed",
        { error: hold.reason.slice(0, 300) },
        deps,
      )) ?? (await reread(c.id, deps)),
    );

  const sentAt = nowOf(deps);
  const sending = await deps.commands.transition(
    c.id,
    ["claimed"],
    {
      status: "sending",
      holdRef: hold.reference,
      sentAt: sentAt.toISOString(),
      deadlineAt: later(sentAt, UNCERTAIN_WAIT_MS),
    },
    sentAt.toISOString(),
  );
  if (!sending) {
    // The sweep ended it while the hold was being placed: nothing is sent, and the
    // hold just placed goes back.
    const held = await reread(c.id, deps);
    await release({ ...held, holdRef: hold.reference }, deps, {
      uncertain: false,
    });
    return done(held);
  }

  const body: StartSession = {
    response_url: responseUrl(sending),
    token: toOcpiToken(token, now),
    location_id: location.id,
    authorization_reference: sending.authorizationReference!,
  };
  if (evse) body.evse_uid = evse.uid;
  if (connector) body.connector_id = connector.id;
  return done(await send(sending, body, peer, deps));
}

/** The default SessionOwner: the driver whose start the Sessions module linked it to. */
export const startedSessionOwner: SessionOwner = async (
  peerId,
  sessionId,
  deps,
) => {
  const start = await deps.commands.findStartBySession(peerId, sessionId);
  return start
    ? {
        driverRef: start.driverRef,
        party: { countryCode: start.toCountryCode, partyId: start.toPartyId },
      }
    : null;
};

/**
 * Stops one of the driver's own sessions: the CPO's session ID, at that peer. Never a
 * guess: a session that is not the driver's is refused like an unknown one.
 */
export async function stopSession(
  input: {
    driverRef: string;
    requestId: string;
    peerId: string;
    sessionId: string;
  },
  deps: CommandDeps,
): Promise<CommandOutcome> {
  const ref = driverRef(input.driverRef);
  const reqId = requestId(input.requestId);
  const sessionId = input.sessionId.trim();
  const peerId = input.peerId.trim();
  if (!OCPI_ID.test(sessionId) || !peerId)
    throw new CommandError("No such session.", 404);
  const owner = await (deps.sessionOwner ?? startedSessionOwner)(
    peerId,
    sessionId,
    deps,
  );
  if (!owner || owner.driverRef !== ref)
    throw new CommandError("No such session.", 404);
  const peer = await commandPeer(peerId, deps);
  const now = nowOf(deps);

  const claimed = await claim(
    {
      type: "STOP_SESSION",
      driverRef: ref,
      requestId: reqId,
      peerId,
      toCountryCode: owner.party.countryCode,
      toPartyId: owner.party.partyId,
      locationId: null,
      evseUid: null,
      connectorId: null,
      sessionId,
      authorizationReference: null,
      deadlineAt: later(now, CLAIM_TTL_MS),
    },
    (held) => held.peerId === peerId && held.sessionId === sessionId,
    deps,
  );
  if (claimed.done) return claimed.done;
  const c = claimed.command;
  const done = (x: Command): Promise<CommandOutcome> =>
    viewCommand(x, deps).then((command) => ({ state: "created", command }));

  if (peer && !commandsReceiver(peer))
    return done(
      (await finish(
        c,
        ["claimed"],
        "not_supported",
        { error: "This CPO offers no Commands Receiver" },
        deps,
      )) ?? (await reread(c.id, deps)),
    );
  const sentAt = nowOf(deps);
  const sending = await deps.commands.transition(
    c.id,
    ["claimed"],
    {
      status: "sending",
      sentAt: sentAt.toISOString(),
      deadlineAt: later(sentAt, UNCERTAIN_WAIT_MS),
    },
    sentAt.toISOString(),
  );
  if (!sending) return done(await reread(c.id, deps));
  return done(
    await send(
      sending,
      { response_url: responseUrl(sending), session_id: sessionId },
      peer,
      deps,
    ),
  );
}

/**
 * Applies a CommandResult from the command's CPO (receiver.ts). An open command ends
 * with it. One that we already timed out keeps its state and records the late result
 * (the Sessions module shows whether a session runs); any other final command is
 * left as it is.
 */
export async function applyCommandResult(
  c: Command,
  r: CommandResult,
  deps: CommandDeps,
): Promise<Command> {
  if (c.status === "sending" || c.status === "accepted") {
    const done = await finish(
      c,
      ["sending", "accepted"],
      resultStatus(r.result),
      { result: r.result, peerMessage: peerText(r.message) || c.peerMessage },
      deps,
    );
    if (done) return done;
    c = await reread(c.id, deps);
  }
  if (c.status === "timed_out" && c.result === null && c.lateResult === null) {
    const late = await deps.commands.transition(
      c.id,
      ["timed_out"],
      { lateResult: r.result },
      nowOf(deps).toISOString(),
    );
    if (late) {
      await audit(deps, "command.late_result", late, { result: r.result });
      return late;
    }
  }
  return c;
}

/** Ends one overdue command: unsent claims as failed, the rest as timed out. */
async function expire(c: Command, deps: CommandDeps): Promise<Command> {
  const done =
    c.status === "claimed"
      ? await finish(
          c,
          ["claimed"],
          "failed",
          { error: "Not sent: it stopped before the request went out" },
          deps,
        )
      : await finish(
          c,
          ["sending", "accepted"],
          "timed_out",
          { error: c.error || "No CommandResult before the deadline" },
          deps,
        );
  return done ?? reread(c.id, deps);
}

const overdue = (c: Command, now: Date) =>
  (OPEN_STATUSES as readonly string[]).includes(c.status) &&
  Date.parse(c.deadlineAt) <= now.getTime();

/**
 * One of the driver's commands, for the app to poll. Null for another driver's. An
 * open command past its deadline is ended first, so the app never waits forever.
 */
export async function getCommand(
  id: string,
  ref: string,
  deps: CommandDeps,
): Promise<CommandView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  let c = await deps.commands.get(id.toLowerCase());
  if (!c || c.driverRef !== driverRef(ref)) return null;
  if (overdue(c, nowOf(deps))) c = await expire(c, deps);
  return viewCommand(c, deps);
}

/** Ends overdue commands, for the cron route. Returns how many. */
export async function expireCommands(
  deps: CommandDeps,
  { limit = 100 } = {},
): Promise<number> {
  const now = nowOf(deps);
  let ended = 0;
  for (const c of await deps.commands.overdue(now.toISOString(), limit))
    if (FINAL_STATUSES.includes((await expire(c, deps)).status as FinalStatus))
      ended++;
  return ended;
}

/**
 * Links a CPO session to the start it came from, by the authorization_reference the
 * CPO puts on the session: for the Sessions module. Returns false when the reference
 * is not one of this peer's starts, or the start is linked to another session.
 */
export async function linkSession(
  input: { peerId: string; authorizationReference: string; sessionId: string },
  deps: CommandDeps,
): Promise<boolean> {
  const c = await deps.commands.getByAuthorizationReference(
    input.authorizationReference,
  );
  if (!c || c.type !== "START_SESSION" || c.peerId !== input.peerId)
    return false;
  if (c.sessionId) return c.sessionId === input.sessionId;
  return (
    (await deps.commands.transition(
      c.id,
      [...OPEN_STATUSES, ...FINAL_STATUSES],
      { sessionId: input.sessionId },
      nowOf(deps).toISOString(),
    )) !== null
  );
}
