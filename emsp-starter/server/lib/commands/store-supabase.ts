import "server-only";
import type {
  CommandResponseType,
  CommandResultType,
} from "@/lib/ocpi/command-objects";
import {
  eq,
  inList,
  supabaseRest,
  type SupabaseTransport,
} from "@/lib/server/supabase-rest";
import {
  OPEN_STATUSES,
  type ClaimOutcome,
  type Command,
  type CommandKind,
  type CommandPatch,
  type CommandStatus,
  type CommandStore,
  type NewCommand,
} from "./store";

type CommandRow = {
  id: string;
  type: CommandKind;
  driver_ref: string;
  request_id: string;
  peer_id: string;
  to_country_code: string;
  to_party_id: string;
  location_id: string | null;
  evse_uid: string | null;
  connector_id: string | null;
  session_id: string | null;
  authorization_reference: string | null;
  status: CommandStatus;
  response_result: CommandResponseType | null;
  response_timeout_s: number | null;
  result: CommandResultType | null;
  late_result: CommandResultType | null;
  outcome_uncertain: boolean;
  peer_message: string;
  error: string;
  hold_ref: string | null;
  deadline_at: string;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  finished_at: string | null;
};

/** Postgres returns `+00:00`; the rest of the server works with `Z` ISO strings. */
const iso = (v: string) => new Date(v).toISOString();
const isoOrNull = (v: string | null) => (v === null ? null : iso(v));

const command = (r: CommandRow): Command => ({
  id: r.id,
  type: r.type,
  driverRef: r.driver_ref,
  requestId: r.request_id,
  peerId: r.peer_id,
  toCountryCode: r.to_country_code,
  toPartyId: r.to_party_id,
  locationId: r.location_id,
  evseUid: r.evse_uid,
  connectorId: r.connector_id,
  sessionId: r.session_id,
  authorizationReference: r.authorization_reference,
  status: r.status,
  responseResult: r.response_result,
  responseTimeoutS: r.response_timeout_s,
  result: r.result,
  lateResult: r.late_result,
  outcomeUncertain: r.outcome_uncertain,
  peerMessage: r.peer_message,
  error: r.error,
  holdRef: r.hold_ref,
  deadlineAt: iso(r.deadline_at),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  sentAt: isoOrNull(r.sent_at),
  finishedAt: isoOrNull(r.finished_at),
});

const COLUMNS: Record<keyof CommandPatch, keyof CommandRow> = {
  status: "status",
  responseResult: "response_result",
  responseTimeoutS: "response_timeout_s",
  result: "result",
  lateResult: "late_result",
  outcomeUncertain: "outcome_uncertain",
  peerMessage: "peer_message",
  error: "error",
  holdRef: "hold_ref",
  deadlineAt: "deadline_at",
  sentAt: "sent_at",
  finishedAt: "finished_at",
  sessionId: "session_id",
};

const enc = encodeURIComponent;

/**
 * Commands in Supabase Postgres (emsp_commands), through the Data API as the service
 * role. A claim is one call to emsp_command_claim, which holds a lock per driver (and
 * per session) for its check and insert; every change is a compare-and-swap on the
 * status.
 */
export class SupabaseCommandStore implements CommandStore {
  private readonly rest: ReturnType<typeof supabaseRest>;

  constructor(
    url: string,
    serviceRoleKey: string,
    transport?: SupabaseTransport,
  ) {
    this.rest = supabaseRest(url, serviceRoleKey, transport);
  }

  async claim(c: NewCommand): Promise<ClaimOutcome> {
    const [row] = await this.rest<
      { outcome: ClaimOutcome["outcome"]; command: CommandRow }[]
    >("POST", "rpc/emsp_command_claim", {
      p_type: c.type,
      p_driver_ref: c.driverRef,
      p_request_id: c.requestId,
      p_peer_id: c.peerId,
      p_to_country_code: c.toCountryCode,
      p_to_party_id: c.toPartyId,
      p_location_id: c.locationId,
      p_evse_uid: c.evseUid,
      p_connector_id: c.connectorId,
      p_session_id: c.sessionId,
      p_authorization_reference: c.authorizationReference,
      p_deadline_at: c.deadlineAt,
    });
    if (!row) throw new Error("Database request failed: emsp_command_claim");
    return { outcome: row.outcome, command: command(row.command) };
  }

  private async one(filter: string): Promise<Command | null> {
    const [row] = await this.rest<CommandRow[]>(
      "GET",
      `emsp_commands?${filter}&select=*`,
    );
    return row ? command(row) : null;
  }

  get(id: string) {
    return this.one(`id=${eq(id)}`);
  }

  getByAuthorizationReference(ref: string) {
    return this.one(`authorization_reference=${eq(ref)}`);
  }

  findStartBySession(peerId: string, sessionId: string) {
    return this.one(
      `type=eq.START_SESSION&peer_id=${eq(peerId)}&session_id=${eq(sessionId)}&order=created_at.desc&limit=1`,
    );
  }

  async transition(
    id: string,
    from: readonly CommandStatus[],
    patch: CommandPatch,
    now: string,
  ) {
    const body: Record<string, unknown> = { updated_at: now };
    for (const [k, v] of Object.entries(patch))
      if (v !== undefined) body[COLUMNS[k as keyof CommandPatch]] = v;
    const [row] = await this.rest<CommandRow[]>(
      "PATCH",
      `emsp_commands?id=${eq(id)}&status=${inList([...from])}&select=*`,
      body,
      "return=representation",
    );
    return row ? command(row) : null;
  }

  async overdue(now: string, limit: number) {
    const rows = await this.rest<CommandRow[]>(
      "GET",
      `emsp_commands?status=${inList([...OPEN_STATUSES])}&deadline_at=lte.${enc(now)}&select=*&order=deadline_at.asc&limit=${limit}`,
    );
    return rows.map(command);
  }
}
