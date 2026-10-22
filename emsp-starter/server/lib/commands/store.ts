import "server-only";
import { randomUUID } from "node:crypto";
import type {
  CommandResponseType,
  CommandResultType,
} from "@/lib/ocpi/command-objects";

/**
 * The commands we send to CPOs (START_SESSION, STOP_SESSION), one row per app request.
 *
 * Status, in order:
 *
 * - `claimed`: the app's request is recorded; nothing has been sent. A start places its
 *   payment hold here.
 * - `sending`: the request is going to the CPO, or went and its outcome is unknown (a
 *   timeout, an HTTP 5xx, no CommandResponse). It is never sent again: it waits for the
 *   CommandResult or its deadline.
 * - `accepted`: the CPO answered ACCEPTED and forwards it to the charger; waiting for
 *   the CommandResult.
 * - Final: `succeeded` (CommandResult ACCEPTED), `failed`, `not_supported` (the charger
 *   or CPO does not take this command from apps), `timed_out`, and `hold_failed` (a
 *   start whose payment hold was refused: nothing was sent).
 *
 * Every change is a compare-and-swap on the status, so a CommandResult that lands while
 * we are still reading the CommandResponse, or the timeout sweep, never overwrites
 * another final state.
 */
export type CommandKind = "START_SESSION" | "STOP_SESSION";

export const OPEN_STATUSES = ["claimed", "sending", "accepted"] as const;
export const FINAL_STATUSES = [
  "succeeded",
  "failed",
  "not_supported",
  "timed_out",
  "hold_failed",
] as const;
export type OpenStatus = (typeof OPEN_STATUSES)[number];
export type FinalStatus = (typeof FINAL_STATUSES)[number];
export type CommandStatus = OpenStatus | FinalStatus;

export type Command = {
  /** Also the last segment of our response_url. */
  id: string;
  type: CommandKind;
  driverRef: string;
  /** The app's request ID: one command per driver, type and request ID. */
  requestId: string;
  peerId: string;
  /** The CPO party the command is addressed to (routing headers). */
  toCountryCode: string;
  toPartyId: string;
  /** A start's location, EVSE and connector, as the CPO knows them. */
  locationId: string | null;
  evseUid: string | null;
  connectorId: string | null;
  /** A stop's session; a start's, once the Sessions module links it. */
  sessionId: string | null;
  /** A start's reference, which the CPO puts on the session and CDR. */
  authorizationReference: string | null;
  status: CommandStatus;
  responseResult: CommandResponseType | null;
  /** Seconds, from the CommandResponse. */
  responseTimeoutS: number | null;
  result: CommandResultType | null;
  /** A CommandResult that arrived after we timed out the command. */
  lateResult: CommandResultType | null;
  /** True when the CPO's answer to the request never arrived (timeout, 5xx, bad body). */
  outcomeUncertain: boolean;
  /** The CPO's message to the driver, when it gave one. */
  peerMessage: string;
  /** Safe to show: method, host and path, and the peer's status. Never a token. */
  error: string;
  /** The payment hold's reference, from the pre-authorization hook. */
  holdRef: string | null;
  /** An open command that reaches this ends: claimed as failed, else as timed_out. */
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  finishedAt: string | null;
};

export type NewCommand = Pick<
  Command,
  | "type"
  | "driverRef"
  | "requestId"
  | "peerId"
  | "toCountryCode"
  | "toPartyId"
  | "locationId"
  | "evseUid"
  | "connectorId"
  | "sessionId"
  | "authorizationReference"
  | "deadlineAt"
>;

export type CommandPatch = Partial<
  Pick<
    Command,
    | "status"
    | "responseResult"
    | "responseTimeoutS"
    | "result"
    | "lateResult"
    | "outcomeUncertain"
    | "peerMessage"
    | "error"
    | "holdRef"
    | "deadlineAt"
    | "sentAt"
    | "finishedAt"
    | "sessionId"
  >
>;

/**
 * - `created`: a new command; the caller sends it.
 * - `replayed`: this request ID has a command already; nothing is sent again.
 * - `busy`: another command is open (a start for this driver, or a stop of this
 *   session); nothing is sent. `command` is that one.
 */
export type ClaimOutcome = {
  outcome: "created" | "replayed" | "busy";
  command: Command;
};

export interface CommandStore {
  /**
   * Records the app's request in one atomic step: returns the command already held for
   * this driver, type and request ID, or the open one that blocks it, or a new one.
   */
  claim(command: NewCommand): Promise<ClaimOutcome>;
  get(id: string): Promise<Command | null>;
  /** The command this driver's request ID already has, of this type. */
  findByRequest(
    driverRef: string,
    type: CommandKind,
    requestId: string,
  ): Promise<Command | null>;
  getByAuthorizationReference(ref: string): Promise<Command | null>;
  /** The newest start linked to this session of this peer. */
  findStartBySession(
    peerId: string,
    sessionId: string,
  ): Promise<Command | null>;
  /**
   * Changes a command only while its status is one of `from`. Null when it is not
   * (another change got there first): read it again.
   */
  transition(
    id: string,
    from: readonly CommandStatus[],
    patch: CommandPatch,
    now: string,
  ): Promise<Command | null>;
  /** Open commands at or past their deadline, oldest deadline first. */
  overdue(now: string, limit: number): Promise<Command[]>;
  /**
   * Sets a start's session only while it has none, whatever its status. Null when it
   * has one already (another link got there first): read it again.
   */
  linkSession(
    id: string,
    sessionId: string,
    now: string,
  ): Promise<Command | null>;
}

const ms = (iso: string) => Date.parse(iso);
const isOpen = (s: CommandStatus) =>
  (OPEN_STATUSES as readonly string[]).includes(s);

/** Commands in memory: for demo mode (nothing persists) and for tests. */
export class MemoryCommandStore implements CommandStore {
  readonly commands = new Map<string, Command>();

  // No awaits before the writes: the checks and the insert are one step, like the
  // database function's lock.
  async claim(c: NewCommand): Promise<ClaimOutcome> {
    const all = [...this.commands.values()];
    const held = all.find(
      (x) =>
        x.driverRef === c.driverRef &&
        x.type === c.type &&
        x.requestId === c.requestId,
    );
    if (held) return { outcome: "replayed", command: structuredClone(held) };
    const open = all.find(
      (x) =>
        isOpen(x.status) &&
        x.type === c.type &&
        (c.type === "START_SESSION"
          ? x.driverRef === c.driverRef
          : x.peerId === c.peerId && x.sessionId === c.sessionId),
    );
    if (open) return { outcome: "busy", command: structuredClone(open) };
    const now = new Date().toISOString();
    const command: Command = {
      ...structuredClone(c),
      id: randomUUID(),
      status: "claimed",
      responseResult: null,
      responseTimeoutS: null,
      result: null,
      lateResult: null,
      outcomeUncertain: false,
      peerMessage: "",
      error: "",
      holdRef: null,
      createdAt: now,
      updatedAt: now,
      sentAt: null,
      finishedAt: null,
    };
    this.commands.set(command.id, command);
    return { outcome: "created", command: structuredClone(command) };
  }

  async get(id: string) {
    const c = this.commands.get(id);
    return c ? structuredClone(c) : null;
  }

  async findByRequest(driverRef: string, type: CommandKind, requestId: string) {
    for (const c of this.commands.values())
      if (
        c.driverRef === driverRef &&
        c.type === type &&
        c.requestId === requestId
      )
        return structuredClone(c);
    return null;
  }

  async getByAuthorizationReference(ref: string) {
    for (const c of this.commands.values())
      if (c.authorizationReference === ref) return structuredClone(c);
    return null;
  }

  async findStartBySession(peerId: string, sessionId: string) {
    const found = [...this.commands.values()]
      .filter(
        (c) =>
          c.type === "START_SESSION" &&
          c.peerId === peerId &&
          c.sessionId === sessionId,
      )
      .sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0];
    return found ? structuredClone(found) : null;
  }

  async transition(
    id: string,
    from: readonly CommandStatus[],
    patch: CommandPatch,
    now: string,
  ) {
    const c = this.commands.get(id);
    if (!c || !from.includes(c.status)) return null;
    Object.assign(c, structuredClone(patch), { updatedAt: now });
    return structuredClone(c);
  }

  async overdue(now: string, limit: number) {
    return [...this.commands.values()]
      .filter((c) => isOpen(c.status) && ms(c.deadlineAt) <= ms(now))
      .sort((a, b) => ms(a.deadlineAt) - ms(b.deadlineAt))
      .slice(0, limit)
      .map((c) => structuredClone(c));
  }

  async linkSession(id: string, sessionId: string, now: string) {
    const c = this.commands.get(id);
    if (!c || c.sessionId !== null) return null;
    Object.assign(c, { sessionId, updatedAt: now });
    return structuredClone(c);
  }
}
