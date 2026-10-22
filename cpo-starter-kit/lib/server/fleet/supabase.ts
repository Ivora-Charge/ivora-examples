import "server-only";
import type { Database } from "../database.types";
import { serviceClient } from "../supabase";
import type { CardLedger, LedgerSession } from "./types";

type DbError = { message: string; code?: string } | null;
type Row = Database["public"]["Tables"]["cpo_card_sessions"]["Row"];

function check<R extends { error: DbError }>(r: R): R {
  if (!r.error) return r;
  // Not the message: it can quote values. The Postgres code is enough to debug.
  throw new Error(
    `Supabase request failed (${r.error.code ?? "unknown"}). Check the migrations and keys.`,
  );
}

const iso = (ms: number) => new Date(ms).toISOString();
const posInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
/** Postgres bigint and numeric values may come back as text. */
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** A ledger row, or null for one the kit can't read (skipped with a log). */
function toSession(r: Row): LedgerSession | null {
  const transactionId = num(r.transaction_id);
  const stationId = num(r.station_id);
  if (!posInt(transactionId) || !posInt(stationId) || !r.token_key) {
    console.error("cpo-starter-kit: skipped an unreadable card session", {
      transactionId: r.transaction_id,
    });
    return null;
  }
  const energy = num(r.energy_wh);
  return {
    transactionId,
    stationId,
    connectorNumber: num(r.connector_number),
    key: r.token_key,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    energyWh: energy !== null && Number.isSafeInteger(energy) ? energy : null,
    active: r.active,
  };
}

/** Rows per request when paging through marks. */
const PAGE = 1000;

/**
 * The card ledger in Supabase (cpo_card_sessions, cpo_card_marks), written and read
 * with the service role through the functions in the cards migration. The server
 * checks the staff member's role before any read reaches it.
 */
export function createSupabaseLedger(): CardLedger {
  return {
    mode: "live",
    async usage(since, until) {
      const { data } = check(
        await serviceClient().rpc("cpo_card_usage", {
          p_since: iso(since),
          p_until: iso(until),
        }),
      );
      return (data ?? []).map((u) => ({
        key: u.token_key,
        sessions: Number(u.sessions),
        running: Number(u.running),
        energyWh: Number(u.energy_wh),
      }));
    },
    async sessions(key, since, until, limit) {
      const { data } = check(
        await serviceClient().rpc("cpo_card_session_list", {
          p_token_key: key,
          p_since: iso(since),
          p_until: iso(until),
          p_limit: limit,
        }),
      );
      return (data ?? []).flatMap((r) => toSession(r) ?? []);
    },
    async getTransactionMark(stationId) {
      const { data } = check(
        await serviceClient()
          .from("cpo_card_marks")
          .select("last_transaction_id")
          .eq("station_id", stationId)
          .maybeSingle(),
      );
      return data ? Number(data.last_transaction_id) : null;
    },
    async advanceTransactionMark(stationId, transactionId, scanned = false) {
      check(
        await serviceClient().rpc("cpo_advance_card_mark", {
          p_station_id: stationId,
          p_transaction_id: transactionId,
          p_scanned: scanned,
        }),
      );
    },
    async scannedAt() {
      const out = new Map<number, number>();
      for (let from = 0; ; from += PAGE) {
        const { data } = check(
          await serviceClient()
            .from("cpo_card_marks")
            .select("station_id, scanned_at")
            .not("scanned_at", "is", null)
            .order("station_id")
            .range(from, from + PAGE - 1),
        );
        for (const m of data ?? [])
          if (m.scanned_at)
            out.set(Number(m.station_id), Date.parse(m.scanned_at));
        if ((data ?? []).length < PAGE) return out;
      }
    },
    async record(s) {
      check(
        await serviceClient().rpc("cpo_record_card_session", {
          p_transaction_id: s.transactionId,
          p_station_id: s.stationId,
          p_connector_number: s.connectorNumber,
          p_token_key: s.key,
          p_started_at: s.startedAt,
          p_ended_at: s.endedAt,
          p_energy_wh: s.energyWh,
          p_active: s.active,
        }),
      );
    },
    async forget(transactionId) {
      check(
        await serviceClient().rpc("cpo_forget_card_session", {
          p_transaction_id: transactionId,
        }),
      );
    },
    async due(before, limit) {
      const { data } = check(
        await serviceClient()
          .from("cpo_card_sessions")
          .select("transaction_id, station_id")
          .eq("active", true)
          .lt("checked_at", iso(before))
          .order("checked_at")
          .limit(limit),
      );
      return (data ?? []).map((r) => ({
        transactionId: Number(r.transaction_id),
        stationId: Number(r.station_id),
      }));
    },
  };
}
