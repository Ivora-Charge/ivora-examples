import "server-only";
import type { Json } from "../database.types";
import { serviceClient } from "../supabase";
import {
  busy,
  notAllowed,
  notFound,
  notReady,
  PricingError,
  stationChanged,
  tariffChanged,
  type KitTariff,
  type PricingStore,
  type StationPricing,
  type TariffDefinition,
} from "./types";

type DbError = { message: string; code?: string } | null;

function check<R extends { error: DbError }>(r: R): R {
  if (!r.error) return r;
  const m = r.error.message;
  if (m.includes("cpo_not_allowed")) throw notAllowed();
  if (m.includes("cpo_tariff_not_found")) throw notFound();
  if (m.includes("cpo_tariff_busy")) throw busy();
  if (m.includes("cpo_tariff_changed")) throw tariffChanged();
  if (m.includes("cpo_station_changed")) throw stationChanged();
  if (m.includes("cpo_tariff_not_ready")) throw notReady();
  if (m.includes("cpo_invalid"))
    throw new PricingError("invalid", "Check the form and try again.");
  // Not the message: it can quote values. The Postgres code is enough to debug.
  throw new Error(
    `Supabase request failed (${r.error.code ?? "unknown"}). Check the migrations and keys.`,
  );
}

/**
 * Tariffs, versions and assignments in Supabase (cpo_tariffs, cpo_tariff_versions,
 * cpo_station_pricing, cpo_connector_tariffs). Service role only, for the operator of
 * the signed-in staff member; writes go through functions that check the actor is an
 * owner or manager in the same statement.
 */
export function createSupabasePricingStore(): PricingStore {
  const svc = () => serviceClient();
  const rpc = async (
    ...a: Parameters<ReturnType<typeof serviceClient>["rpc"]>
  ) => check(await svc().rpc(...a)).data;
  return {
    mode: "live",
    async load(operatorId) {
      const [tariffs, versions, stations, connectors] = await Promise.all([
        svc()
          .from("cpo_tariffs")
          .select("id, name, revision")
          .eq("operator_id", operatorId)
          .then(check),
        svc()
          .from("cpo_tariff_versions")
          .select(
            "tariff_id, version, definition, ivora_tariff_id, attempt, attempted_at, created_at, archived_at",
          )
          .eq("operator_id", operatorId)
          .order("version", { ascending: false })
          .then(check),
        svc()
          .from("cpo_station_pricing")
          .select("station_id, tariff_id, private, revision")
          .eq("operator_id", operatorId)
          .then(check),
        svc()
          .from("cpo_connector_tariffs")
          .select("station_id, connector_id, tariff_id")
          .eq("operator_id", operatorId)
          .then(check),
      ]);
      const byTariff = new Map<string, KitTariff["versions"]>();
      for (const v of versions.data ?? []) {
        const list = byTariff.get(v.tariff_id) ?? [];
        list.push({
          version: v.version,
          ivoraTariffId: v.ivora_tariff_id,
          attempt: v.attempt,
          attemptedAt: v.attempted_at,
          definition: v.definition as unknown as TariffDefinition,
          createdAt: v.created_at,
          archivedAt: v.archived_at,
        });
        byTariff.set(v.tariff_id, list);
      }
      const byStation = new Map<number, StationPricing>();
      const station = (id: number) => {
        let s = byStation.get(id);
        if (!s) {
          s = {
            stationId: id,
            tariffId: null,
            private: false,
            connectors: {},
            revision: 0,
          };
          byStation.set(id, s);
        }
        return s;
      };
      for (const s of stations.data ?? [])
        Object.assign(station(s.station_id), {
          tariffId: s.tariff_id,
          private: s.private,
          revision: s.revision,
        });
      for (const c of connectors.data ?? [])
        station(c.station_id).connectors[String(c.connector_id)] = c.tariff_id;
      return {
        tariffs: (tariffs.data ?? [])
          .map((t) => ({
            id: t.id,
            name: t.name,
            revision: t.revision,
            versions: byTariff.get(t.id) ?? [],
          }))
          .filter((t) => t.versions.length),
        stations: [...byStation.values()],
      };
    },
    async createTariff(actor, name, definition) {
      return (await rpc("cpo_create_tariff", {
        p_operator_id: actor.operatorId,
        p_actor_id: actor.userId,
        p_name: name,
        p_definition: definition as unknown as Json,
      })) as string;
    },
    async addVersion(actor, tariffId, expectedRevision, name, definition) {
      return (await rpc("cpo_add_tariff_version", {
        p_operator_id: actor.operatorId,
        p_actor_id: actor.userId,
        p_tariff_id: tariffId,
        p_expected_revision: expectedRevision,
        p_name: name,
        p_definition: definition as unknown as Json,
      })) as number;
    },
    async nextAttempt(actor, tariffId, version) {
      return (await rpc("cpo_next_tariff_attempt", {
        p_operator_id: actor.operatorId,
        p_actor_id: actor.userId,
        p_tariff_id: tariffId,
        p_version: version,
      })) as number;
    },
    async recordVersion(actor, tariffId, version, ivoraTariffId) {
      await rpc("cpo_record_tariff_version", {
        p_operator_id: actor.operatorId,
        p_actor_id: actor.userId,
        p_tariff_id: tariffId,
        p_version: version,
        p_ivora_tariff_id: ivoraTariffId,
      });
    },
    async dropVersion(actor, tariffId, version) {
      await rpc("cpo_drop_tariff_version", {
        p_operator_id: actor.operatorId,
        p_actor_id: actor.userId,
        p_tariff_id: tariffId,
        p_version: version,
      });
    },
    async recordArchived(actor, tariffId, version) {
      await rpc("cpo_record_tariff_archived", {
        p_operator_id: actor.operatorId,
        p_actor_id: actor.userId,
        p_tariff_id: tariffId,
        p_version: version,
      });
    },
    async setStation(actor, stationId, expectedRevision, input) {
      await rpc("cpo_set_station_pricing", {
        p_operator_id: actor.operatorId,
        p_actor_id: actor.userId,
        p_station_id: stationId,
        p_expected_revision: expectedRevision,
        p_tariff_id: input.tariffId,
        p_private: input.private,
        p_connectors: input.connectors.map((c) => ({
          connector_id: c.connectorId,
          tariff_id: c.tariffId,
        })),
      });
    },
  };
}
