import "server-only";
import type { Database, Json } from "../database.types";
import { serviceClient } from "../supabase";
import {
  commandBusy,
  LiveError,
  notAllowed,
  type CommandAction,
  type CommandChanges,
  type CommandPhase,
  type LiveCommand,
  type LiveStore,
  type StaffToken,
} from "./types";

type DbError = { message: string; code?: string } | null;
type Row = Database["public"]["Tables"]["cpo_live_commands"]["Row"];

function check<R extends { error: DbError }>(r: R): R {
  if (!r.error) return r;
  const m = r.error.message;
  if (m.includes("cpo_not_allowed")) throw notAllowed();
  if (m.includes("cpo_command_busy")) throw commandBusy();
  if (m.includes("cpo_invalid"))
    throw new LiveError("invalid", "Reload the page and try again.");
  // Not the message: it can quote values. The Postgres code is enough to debug.
  throw new Error(
    `Supabase request failed (${r.error.code ?? "unknown"}). Check the migrations and keys.`,
  );
}

const COLUMNS =
  "id, operator_id, request_id, station_id, action, connector_id, transaction_id, mode, phase, operation_id, charger_status, error, confirmed_sessions, requested_by, requested_at, updated_at, finished_at";

const toCommand = (r: Row): LiveCommand => ({
  id: r.id,
  requestId: r.request_id,
  stationId: r.station_id,
  action: r.action as CommandAction,
  connectorId: r.connector_id,
  transactionId: r.transaction_id,
  mode: r.mode as LiveCommand["mode"],
  phase: r.phase as CommandPhase,
  operationId: r.operation_id,
  chargerStatus: r.charger_status,
  error: r.error,
  confirmedSessions: r.confirmed_sessions ?? [],
  requestedBy: r.requested_by,
  requestedAt: r.requested_at,
  updatedAt: r.updated_at,
  finishedAt: r.finished_at,
});

/** Column names for the changes cpo_record_live_command accepts. */
function changesJson(c: CommandChanges): Json {
  const out: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => {
    if (v !== undefined) out[k] = v;
  };
  set("phase", c.phase);
  set("operation_id", c.operationId);
  set("charger_status", c.chargerStatus);
  set("error", c.error);
  return out as Json;
}

/**
 * Commands, staff tokens and webhook event IDs in Supabase (cpo_live_commands,
 * cpo_staff_tokens, cpo_ivora_events).
 * Service role only, for the operator of the signed-in staff member; a command is
 * claimed by a function that checks the actor's role in the same statement.
 */
export function createSupabaseLiveStore(): LiveStore {
  const svc = () => serviceClient();
  const getCommand = async (operatorId: string, id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { data } = check(
      await svc()
        .from("cpo_live_commands")
        .select(COLUMNS)
        .eq("operator_id", operatorId)
        .eq("id", id)
        .maybeSingle(),
    );
    return data ? toCommand(data as Row) : null;
  };
  const getToken =
    (table: "cpo_staff_tokens" | "cpo_free_tokens") =>
    async (operatorId: string) => {
      const { data } = check(
        await svc()
          .from(table)
          .select("id_token, token_id")
          .eq("operator_id", operatorId)
          .maybeSingle(),
      );
      return data ? { idToken: data.id_token, tokenId: data.token_id } : null;
    };
  const putToken =
    (table: "cpo_staff_tokens" | "cpo_free_tokens") =>
    async (
      operatorId: string,
      t: StaffToken,
      o: { replace?: boolean } = {},
    ) => {
      check(
        await svc()
          .from(table)
          .upsert(
            {
              operator_id: operatorId,
              id_token: t.idToken,
              token_id: t.tokenId,
              registered_at: t.tokenId ? new Date().toISOString() : null,
            },
            { onConflict: "operator_id", ignoreDuplicates: !o.replace },
          ),
      );
      const stored = await getToken(table)(operatorId);
      if (!stored) throw new Error("Token not stored");
      return stored;
    };
  return {
    mode: "live",
    async listCommands(operatorId, o = {}) {
      let q = svc()
        .from("cpo_live_commands")
        .select(COLUMNS)
        .eq("operator_id", operatorId);
      if (o.stationId) q = q.eq("station_id", o.stationId);
      const { data } = check(
        await q
          .order("requested_at", { ascending: false })
          .limit(o.limit ?? 15),
      );
      return ((data ?? []) as Row[]).map(toCommand);
    },
    getCommand,
    async claim(actor, c) {
      const { data } = check(
        await svc().rpc("cpo_claim_live_command", {
          p_operator_id: actor.operatorId,
          p_actor_id: actor.userId,
          p_request_id: c.requestId,
          p_station_id: c.stationId,
          p_action: c.action,
          p_connector_id: c.connectorId,
          p_transaction_id: c.transactionId,
          p_mode: c.mode,
          p_confirmed_sessions: c.confirmedSessions,
        }),
      );
      const r = data as { id: string; created: boolean };
      const command = await getCommand(actor.operatorId, r.id);
      if (!command) throw new Error("Claimed command not found");
      return { command, created: r.created };
    },
    async record(operatorId, id, changes) {
      const { data } = check(
        await svc().rpc("cpo_record_live_command", {
          p_operator_id: operatorId,
          p_id: id,
          p_changes: changesJson(changes),
        }),
      );
      return Boolean(data);
    },
    async findByOperation(operationId) {
      const { data } = check(
        await svc()
          .from("cpo_live_commands")
          .select(COLUMNS)
          .eq("operation_id", operationId)
          .eq("phase", "pending")
          .limit(1)
          .maybeSingle(),
      );
      return data
        ? {
            operatorId: (data as Row).operator_id,
            command: toCommand(data as Row),
          }
        : null;
    },
    getStaffToken: getToken("cpo_staff_tokens"),
    putStaffToken: putToken("cpo_staff_tokens"),
    getFreeToken: getToken("cpo_free_tokens"),
    putFreeToken: putToken("cpo_free_tokens"),
    async getTransactionMark(stationId) {
      const { data } = check(
        await svc()
          .from("cpo_transaction_marks")
          .select("last_transaction_id")
          .eq("station_id", stationId)
          .maybeSingle(),
      );
      return data ? data.last_transaction_id : null;
    },
    async advanceTransactionMark(stationId, transactionId) {
      check(
        await svc().rpc("cpo_advance_transaction_mark", {
          p_station_id: stationId,
          p_transaction_id: transactionId,
        }),
      );
    },
    async listTrackedSessions(o = {}) {
      let q = svc()
        .from("cpo_active_sessions")
        .select(
          "transaction_id, station_id, connector_id, connector_number, id_token, started_at, ended_at, energy_wh, active, checked_at",
        )
        .order("transaction_id", { ascending: false })
        .limit(500);
      if (!o.ended) q = q.eq("active", true);
      if (o.stationId !== undefined) q = q.eq("station_id", o.stationId);
      const { data } = check(await q);
      return (data ?? []).map((r) => ({
        transactionId: r.transaction_id,
        stationId: r.station_id,
        connectorId: r.connector_id,
        connectorNumber: r.connector_number,
        idToken: r.id_token,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        energyWh: r.energy_wh === null ? null : Number(r.energy_wh),
        active: r.active,
        checkedAt: r.checked_at,
      }));
    },
    async trackSession(s) {
      check(
        await svc().rpc("cpo_track_session", {
          p_transaction_id: s.transactionId,
          p_station_id: s.stationId,
          p_connector_id: s.connectorId,
          p_connector_number: s.connectorNumber,
          p_id_token: s.idToken,
          p_started_at: s.startedAt,
          p_ended_at: s.endedAt,
          p_energy_wh: s.energyWh,
          p_active: s.active,
        }),
      );
    },
    async getTrackerMark(stationId) {
      const { data } = check(
        await svc()
          .from("cpo_active_marks")
          .select("last_transaction_id")
          .eq("station_id", stationId)
          .maybeSingle(),
      );
      return data ? data.last_transaction_id : null;
    },
    async advanceTrackerMark(stationId, transactionId) {
      check(
        await svc().rpc("cpo_advance_active_mark", {
          p_station_id: stationId,
          p_transaction_id: transactionId,
        }),
      );
    },
    async recordEvent(e) {
      const { data } = check(
        await svc().rpc("cpo_record_ivora_event", {
          p_id: e.id,
          p_type: e.type,
          p_station_id: e.stationId,
        }),
      );
      return Boolean(data);
    },
    async markProcessed(eventId) {
      check(
        await svc()
          .from("cpo_ivora_events")
          .update({ processed_at: new Date().toISOString() })
          .eq("id", eventId),
      );
    },
    async version(operatorId) {
      const [{ data: event }, { data: command }] = await Promise.all([
        svc()
          .from("cpo_ivora_events")
          .select("received_at, processed_at")
          .order("received_at", { ascending: false })
          .limit(1)
          .maybeSingle()
          .then(check),
        svc()
          .from("cpo_live_commands")
          .select("updated_at")
          .eq("operator_id", operatorId)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle()
          .then(check),
      ]);
      return [
        event?.received_at ?? "",
        event?.processed_at ?? "",
        command?.updated_at ?? "",
      ].join("|");
    },
  };
}
