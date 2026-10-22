import "server-only";
import { isStickerCode } from "@/lib/sticker-codes";
import type { Json } from "../database.types";
import { serviceClient } from "../supabase";
import {
  ChargerError,
  notAllowed,
  notFound,
  testBusy,
  type ChargerChanges,
  type ChargerRecord,
  type ChargerStore,
  type ConnectionTest,
  type NewSite,
  type RemoteTest,
} from "./types";

type DbError = { message: string; code?: string } | null;

function check<R extends { error: DbError }>(r: R): R {
  if (!r.error) return r;
  const m = r.error.message;
  if (m.includes("cpo_not_allowed")) throw notAllowed();
  if (m.includes("cpo_charger_not_found")) throw notFound();
  if (m.includes("cpo_charger_busy")) throw testBusy();
  if (m.includes("cpo_charger_exists"))
    throw new ChargerError("exists", "This charger is already in the kit.");
  // Not the message: it can quote values. The Postgres code is enough to debug.
  throw new Error(
    `Supabase request failed (${r.error.code ?? "unknown"}). Check the migrations and keys.`,
  );
}

const COLUMNS =
  "id, station_id, name, label, location_id, new_site, connectors, connection_url, password_set_at, connection_test, remote_test, created_at, removed_at";

/** Column names for the changes cpo_update_charger accepts. */
function changesJson(c: ChargerChanges): Json {
  const out: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => {
    if (v !== undefined) out[k] = v;
  };
  set("label", c.label);
  set("location_id", c.locationId);
  set("new_site", c.newSite);
  set("station_id", c.stationId);
  set("connection_url", c.connectionUrl);
  set("password_set_at", c.passwordSetAt);
  set("connection_test", c.connectionTest);
  set("remote_test", c.remoteTest);
  return out as Json;
}

/**
 * Charger records and sticker codes in Supabase (cpo_chargers, cpo_sticker_codes).
 * Service role only, for the operator of the signed-in staff member; writes go through
 * functions that check the actor's role in the same statement.
 */
export function createSupabaseChargerStore(): ChargerStore {
  const svc = () => serviceClient();
  const rpc = async (
    ...a: Parameters<ReturnType<typeof serviceClient>["rpc"]>
  ) => check(await svc().rpc(...a)).data;
  return {
    mode: "live",
    async list(operatorId) {
      const [{ data: rows }, { data: codes }] = await Promise.all([
        svc()
          .from("cpo_chargers")
          .select(COLUMNS)
          .eq("operator_id", operatorId)
          .order("created_at")
          .then(check),
        svc()
          .from("cpo_sticker_codes")
          .select("code, charger_id, connector_number, connector_id")
          .eq("operator_id", operatorId)
          .then(check),
      ]);
      return (rows ?? []).map(
        (r) =>
          ({
            id: r.id,
            stationId: r.station_id,
            name: r.name,
            label: r.label,
            locationId: r.location_id,
            newSite: r.new_site as NewSite | null,
            connectors: r.connectors,
            connectionUrl: r.connection_url,
            passwordSetAt: r.password_set_at,
            connectionTest: r.connection_test as ConnectionTest | null,
            remoteTest: r.remote_test as RemoteTest | null,
            codes: (codes ?? [])
              .filter((c) => c.charger_id === r.id)
              .map((c) => ({
                code: c.code,
                connectorNumber: c.connector_number,
                connectorId: c.connector_id,
              })),
            createdAt: r.created_at,
            removedAt: r.removed_at,
          }) satisfies ChargerRecord,
      );
    },
    async create(actor, r) {
      return (await rpc("cpo_create_charger", {
        p_operator_id: actor.operatorId,
        p_actor_id: actor.userId,
        p_name: r.name,
        p_label: r.label,
        p_location_id: r.locationId,
        p_new_site: r.newSite as Json | null,
        p_connectors: r.connectors,
        p_station_id: r.stationId,
        p_connection_url: r.connectionUrl,
      })) as string;
    },
    async update(actor, id, changes) {
      await rpc("cpo_update_charger", {
        p_operator_id: actor.operatorId,
        p_actor_id: actor.userId,
        p_id: id,
        p_changes: changesJson(changes),
      });
    },
    async nextSeq(actor, id, kind) {
      return (await rpc("cpo_next_charger_seq", {
        p_operator_id: actor.operatorId,
        p_actor_id: actor.userId,
        p_id: id,
        p_kind: kind,
      })) as number;
    },
    async claimTest(actor, id, test) {
      return (await rpc("cpo_claim_charger_test", {
        p_operator_id: actor.operatorId,
        p_actor_id: actor.userId,
        p_id: id,
        p_test: test as unknown as Json,
      })) as number;
    },
    async addCodes(actor, id, codes) {
      await rpc("cpo_add_sticker_codes", {
        p_operator_id: actor.operatorId,
        p_actor_id: actor.userId,
        p_charger_id: id,
        p_codes: codes.map((c) => ({
          code: c.code,
          connector_number: c.connectorNumber,
          connector_id: c.connectorId,
        })),
      });
    },
    async remove(actor, id) {
      await rpc("cpo_remove_charger", {
        p_operator_id: actor.operatorId,
        p_actor_id: actor.userId,
        p_id: id,
      });
    },
    async resolveCode(code) {
      if (!isStickerCode(code)) return null;
      const { data: c } = check(
        await svc()
          .from("cpo_sticker_codes")
          .select(
            "code, operator_id, charger_id, connector_number, connector_id",
          )
          .eq("code", code)
          .maybeSingle(),
      );
      if (!c) return null;
      const [{ data: charger }, { data: profile }, { data: operator }] =
        await Promise.all([
          svc()
            .from("cpo_chargers")
            .select("name, label, removed_at, station_id")
            .eq("id", c.charger_id)
            .maybeSingle()
            .then(check),
          svc()
            .from("cpo_company_profiles")
            .select("name")
            .eq("operator_id", c.operator_id)
            .maybeSingle()
            .then(check),
          svc()
            .from("cpo_operators")
            .select("name")
            .eq("id", c.operator_id)
            .maybeSingle()
            .then(check),
        ]);
      if (!charger) return null;
      return {
        code: c.code,
        operatorId: c.operator_id,
        stationId: charger.station_id,
        connectorId: c.connector_id,
        connectorNumber: c.connector_number,
        chargerName: charger.label ?? charger.name,
        inService: !charger.removed_at,
        operatorName: profile?.name ?? operator?.name ?? null,
      };
    },
  };
}
