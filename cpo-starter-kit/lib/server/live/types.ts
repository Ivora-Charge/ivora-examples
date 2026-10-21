import "server-only";
import type { Staff } from "../team/types";

export const COMMAND_ACTIONS = ["start", "stop", "reset", "unlock"] as const;
export type CommandAction = (typeof COMMAND_ACTIONS)[number];

/**
 * pending: sent (or being sent) and not answered for sure; it blocks other commands on
 * the charger. accepted: the charger said yes (the view then watches the sessions and
 * status to see it happen). failed: a definite refusal by Ivora or the charger.
 * unknown: Ivora could not confirm it reached the charger; never resent.
 */
export type CommandPhase = "pending" | "accepted" | "failed" | "unknown";

/** A charger command a staff member sent from the Live view: the kit's own record. */
export interface LiveCommand {
  /** Our ID: the Idempotency-Key is cpo-command-<id>-<action>. */
  id: string;
  /** The confirmation form's random ID: one tap, one command. */
  requestId: string;
  stationId: number;
  action: CommandAction;
  /** Ivora's connector resource ID (start, unlock). */
  connectorId: number | null;
  /** The session to stop (stop). */
  transactionId: number | null;
  mode: "soft" | "hard" | null;
  phase: CommandPhase;
  operationId: string | null;
  /** The charger's own answer, for example Accepted, Rejected or Unlocked. */
  chargerStatus: string | null;
  error: string | null;
  /** Sessions the staff member confirmed this command may end. */
  confirmedSessions: number[];
  requestedBy: string | null;
  requestedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface NewCommand {
  requestId: string;
  stationId: number;
  action: CommandAction;
  connectorId: number | null;
  transactionId: number | null;
  mode: "soft" | "hard" | null;
  confirmedSessions: number[];
}

export type CommandChanges = Partial<
  Pick<LiveCommand, "phase" | "operationId" | "chargerStatus" | "error">
>;

/** One webhook delivery, as the kit stores it to deduplicate. */
export interface StoredEvent {
  id: string;
  type: string;
  stationId: number | null;
}

/**
 * Where commands and webhook event IDs are kept. The Supabase store claims a command
 * in a database function that checks the actor's role and the charger's pending
 * command in the same statement; the demo store keeps commands in the visitor's
 * cookie and sends nothing anywhere.
 */
export interface LiveStore {
  readonly mode: "live" | "demo";
  /** Newest first. */
  listCommands(
    operatorId: string,
    o?: { stationId?: number; limit?: number },
  ): Promise<LiveCommand[]>;
  getCommand(operatorId: string, id: string): Promise<LiveCommand | null>;
  /**
   * Claims a command atomically: technicians and above only (LiveError
   * "not_allowed"), one pending command per charger (LiveError "busy"). The same
   * requestId again returns the command it made, with created false.
   */
  claim(
    actor: Staff,
    c: NewCommand,
  ): Promise<{ command: LiveCommand; created: boolean }>;
  /** Records what Ivora reported; a final command never changes again. */
  record(
    operatorId: string,
    id: string,
    changes: CommandChanges,
  ): Promise<boolean>;
  /** The pending command waiting on this operation, if any (webhooks). */
  findByOperation(
    operationId: string,
  ): Promise<{ operatorId: string; command: LiveCommand } | null>;
  /** True for a new event, false for a redelivery. */
  recordEvent(e: StoredEvent): Promise<boolean>;
  markProcessed(eventId: string): Promise<void>;
  /** Changes when a webhook arrives or a command changes: the browser's refresh cue. */
  version(operatorId: string): Promise<string>;
}

export type LiveErrorCode =
  "invalid" | "not_allowed" | "not_found" | "not_ready" | "busy" | "confirm";

/** An error staff can act on. The message is safe to show. */
export class LiveError extends Error {
  constructor(
    public code: LiveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LiveError";
  }
}

export const notAllowed = () =>
  new LiveError(
    "not_allowed",
    "Your role can't send charger commands (technicians, managers and owners can). If your role just changed, reload the page.",
  );

export const commandBusy = () =>
  new LiveError(
    "busy",
    "Another command is still waiting for an answer from this charger. Check it first; a second command is not sent.",
  );
