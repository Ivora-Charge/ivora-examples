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
  type TrackedSession,
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

const SESSION_COLUMNS =
  "transaction_id, station_id, connector_id, connector_number, id_token, started_at, ended_at, energy_wh, active, checked_at, changed_at";
type SessionRow = Database["public"]["Tables"]["cpo_active_sessions"]["Row"];
/** Rows per request when paging through tracked sessions or marks. */
const PAGE = 1000;

const posInt = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const time = (v: unknown) =>
  typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null;

/**
 * A tracked session row, or null for one the kit can't read (it is skipped with a
 * log, so one odd row can't take the Live page down).
 */
function toTracked(r: SessionRow): TrackedSession | null {
  const energy = r.energy_wh === null ? null : Number(r.energy_wh);
  const checkedAt = time(r.checked_at);
  if (
    !posInt(r.transaction_id) ||
    !posInt(r.station_id) ||
    typeof r.active !== "boolean" ||
    !checkedAt
  ) {
    console.error("cpo-starter-kit: skipped an unreadable tracked session", {
      transactionId: r.transaction_id,
    });
    return null;
  }
  return {
    transactionId: r.transaction_id,
    stationId: r.station_id,
    connectorId: posInt(r.connector_id) ? r.connector_id : null,
    connectorNumber: Number.isInteger(r.connector_number)
      ? r.connector_number
      : null,
    idToken: typeof r.id_token === "string" ? r.id_token : null,
    startedAt: time(r.started_at),
    endedAt: time(r.ended_at),
    energyWh:
      energy !== null && Number.isFinite(energy) && energy >= 0 ? energy : null,
    active: r.active,
    checkedAt,
    changedAt: time(r.changed_at) ?? checkedAt,
  };
}

const tracked = (rows: SessionRow[] | null) =>
  (rows ?? []).map(toTracked).filter((t) => t !== null);

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
    async listActiveSessions(o = {}) {
      const out: TrackedSession[] = [];
      // Keyset pages, so a row added meanwhile can't shift one out of the list.
      for (let before: number | null = null; ;) {
        let q = svc()
          .from("cpo_active_sessions")
          .select(SESSION_COLUMNS)
          .eq("active", true)
          .order("transaction_id", { ascending: false })
          .limit(PAGE);
        if (o.stationId !== undefined) q = q.eq("station_id", o.stationId);
        if (before !== null) q = q.lt("transaction_id", before);
        const { data } = check(await q);
        const rows = (data ?? []) as SessionRow[];
        out.push(...tracked(rows));
        if (rows.length < PAGE) return out;
        before = rows[rows.length - 1].transaction_id;
      }
    },
    async listEndedSessions(stationId, o = {}) {
      let q = svc()
        .from("cpo_active_sessions")
        .select(SESSION_COLUMNS)
        .eq("station_id", stationId)
        .eq("active", false)
        .order("transaction_id", { ascending: false })
        .limit(o.limit ?? 20);
      if (o.before !== undefined) q = q.lt("transaction_id", o.before);
      const { data } = check(await q);
      return tracked(data as SessionRow[] | null);
    },
    async getTrackedSession(transactionId) {
      const { data } = check(
        await svc()
          .from("cpo_active_sessions")
          .select(SESSION_COLUMNS)
          .eq("transaction_id", transactionId)
          .maybeSingle(),
      );
      return data ? toTracked(data as SessionRow) : null;
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
    async forgetSession(transactionId) {
      check(
        await svc().rpc("cpo_forget_session", {
          p_transaction_id: transactionId,
        }),
      );
    },
    async forgetRemovedStations(keep) {
      check(await svc().rpc("cpo_forget_removed_stations", { p_keep: keep }));
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
    async listTrackerMarks() {
      const out = new Map<number, { mark: number; scannedAt: string | null }>();
      for (let after = 0; ;) {
        const { data } = check(
          await svc()
            .from("cpo_active_marks")
            .select("station_id, last_transaction_id, scanned_at")
            .gt("station_id", after)
            .order("station_id", { ascending: true })
            .limit(PAGE),
        );
        const rows = data ?? [];
        for (const r of rows)
          out.set(r.station_id, {
            mark: r.last_transaction_id,
            scannedAt: r.scanned_at,
          });
        if (rows.length < PAGE) return out;
        after = rows[rows.length - 1].station_id;
      }
    },
    async advanceTrackerMark(stationId, transactionId, o = {}) {
      check(
        await svc().rpc("cpo_advance_active_mark", {
          p_station_id: stationId,
          p_transaction_id: transactionId,
          p_scanned: Boolean(o.scanned),
        }),
      );
    },
    async getTrackerSeed(stationId) {
      const { data } = check(
        await svc()
          .from("cpo_active_marks")
          .select("seed_lo, seed_hi")
          .eq("station_id", stationId)
          .maybeSingle(),
      );
      return data?.seed_lo != null
        ? { lo: data.seed_lo, hi: data.seed_hi }
        : null;
    },
    async saveTrackerSeed(stationId, p) {
      check(
        await svc().rpc("cpo_save_active_seed", {
          p_station_id: stationId,
          p_lo: p.lo,
          p_hi: p.hi,
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
