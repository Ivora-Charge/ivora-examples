import "server-only";
import type { Location } from "@/lib/ocpi/locations";
import type { Tariff } from "@/lib/ocpi/tariffs";
import {
  eq,
  inList,
  supabaseRest,
  type SupabaseTransport,
} from "@/lib/server/supabase-rest";
import {
  searchIds,
  searchText,
  type CandidateFilter,
  type LocationStore,
  type ObjectKey,
  type StoredLocation,
  type StoredTariff,
  type SyncModule,
  type SyncState,
} from "./store";

type LocationRow = { peer_id: string; data: Location; seen_at: string };
type TariffRow = { peer_id: string; data: Tariff; seen_at: string };
type SyncRow = {
  peer_id: string;
  module: SyncModule;
  last_full_sync_at: string | null;
  cursor: string | null;
  run_id: string | null;
  run: SyncState["run"];
  last_result: SyncState["lastResult"];
};

const keyFilter = (k: ObjectKey, idColumn: string) =>
  `peer_id=${eq(k.peerId)}&country_code=${eq(k.countryCode.toUpperCase())}&party_id=${eq(k.partyId.toUpperCase())}&${idColumn}=${eq(k.id)}`;

/**
 * The locations and tariffs cache in Supabase Postgres (emsp_ocpi_locations,
 * emsp_ocpi_tariffs, emsp_ocpi_sync_state), through the Data API as the service role.
 * Each object is stored whole as jsonb, with the columns the search filters on beside it.
 */
export class SupabaseLocationStore implements LocationStore {
  private readonly rest: ReturnType<typeof supabaseRest>;

  constructor(
    url: string,
    serviceRoleKey: string,
    transport?: SupabaseTransport,
  ) {
    this.rest = supabaseRest(url, serviceRoleKey, transport);
  }

  async getLocation(k: ObjectKey): Promise<StoredLocation | null> {
    const [row] = await this.rest<LocationRow[]>(
      "GET",
      `emsp_ocpi_locations?${keyFilter(k, "location_id")}&select=peer_id,data,seen_at`,
    );
    return row
      ? { peerId: row.peer_id, location: row.data, seenAt: row.seen_at }
      : null;
  }

  async findLocationsById(peerId: string, ids: string[]) {
    if (!ids.length) return [];
    const rows = await this.rest<LocationRow[]>(
      "GET",
      `emsp_ocpi_locations?peer_id=${eq(peerId)}&location_id=${inList(ids)}&select=peer_id,data,seen_at`,
    );
    return rows.map((r) => ({
      peerId: r.peer_id,
      location: r.data,
      seenAt: r.seen_at,
    }));
  }

  async saveLocations(peerId: string, locations: Location[], seenAt: string) {
    if (!locations.length) return;
    const updatedAt = new Date().toISOString();
    await this.rest(
      "POST",
      "emsp_ocpi_locations?on_conflict=peer_id,country_code,party_id,location_id",
      locations.map((l) => ({
        peer_id: peerId,
        country_code: l.country_code,
        party_id: l.party_id,
        location_id: l.id,
        data: l,
        publish: l.publish,
        latitude: Number(l.coordinates.latitude),
        longitude: Number(l.coordinates.longitude),
        search_text: searchText(l),
        search_ids: searchIds(l),
        last_updated: l.last_updated,
        seen_at: seenAt,
        updated_at: updatedAt,
      })),
      "resolution=merge-duplicates,return=minimal",
    );
  }

  async pruneLocations(peerId: string, before: string) {
    const rows = await this.rest<unknown[]>(
      "DELETE",
      `emsp_ocpi_locations?peer_id=${eq(peerId)}&seen_at=lt.${encodeURIComponent(before)}&select=location_id`,
      undefined,
      "return=representation",
    );
    return rows.length;
  }

  async findLocations(f: CandidateFilter): Promise<StoredLocation[]> {
    if (!f.peerIds.length) return [];
    const q = [
      `peer_id=${inList(f.peerIds)}`,
      "publish=is.true",
      "select=peer_id,data,seen_at",
      `limit=${f.limit}`,
    ];
    if (f.bbox) {
      q.push(`latitude=gte.${f.bbox.minLat}`, `latitude=lte.${f.bbox.maxLat}`);
      if (f.bbox.minLng !== undefined)
        q.push(
          `longitude=gte.${f.bbox.minLng}`,
          `longitude=lte.${f.bbox.maxLng}`,
        );
    }
    // Words are letters and digits only (search.ts), so they are safe in a pattern.
    for (const w of f.words ?? [])
      q.push(`search_text=ilike.${encodeURIComponent(`*${w}*`)}`);
    if (f.id) q.push(`search_ids=cs.${encodeURIComponent(`{${f.id}}`)}`);
    const rows = await this.rest<LocationRow[]>(
      "GET",
      `emsp_ocpi_locations?${q.join("&")}`,
    );
    return rows.map((r) => ({
      peerId: r.peer_id,
      location: r.data,
      seenAt: r.seen_at,
    }));
  }

  async getTariff(k: ObjectKey): Promise<StoredTariff | null> {
    const [row] = await this.rest<TariffRow[]>(
      "GET",
      `emsp_ocpi_tariffs?${keyFilter(k, "tariff_id")}&select=peer_id,data,seen_at`,
    );
    return row
      ? { peerId: row.peer_id, tariff: row.data, seenAt: row.seen_at }
      : null;
  }

  async saveTariffs(peerId: string, tariffs: Tariff[], seenAt: string) {
    if (!tariffs.length) return;
    const updatedAt = new Date().toISOString();
    await this.rest(
      "POST",
      "emsp_ocpi_tariffs?on_conflict=peer_id,country_code,party_id,tariff_id",
      tariffs.map((t) => ({
        peer_id: peerId,
        country_code: t.country_code,
        party_id: t.party_id,
        tariff_id: t.id,
        data: t,
        last_updated: t.last_updated,
        seen_at: seenAt,
        updated_at: updatedAt,
      })),
      "resolution=merge-duplicates,return=minimal",
    );
  }

  async deleteTariff(k: ObjectKey) {
    await this.rest(
      "DELETE",
      `emsp_ocpi_tariffs?${keyFilter(k, "tariff_id")}`,
      undefined,
      "return=minimal",
    );
  }

  async pruneTariffs(peerId: string, before: string) {
    const rows = await this.rest<unknown[]>(
      "DELETE",
      `emsp_ocpi_tariffs?peer_id=${eq(peerId)}&seen_at=lt.${encodeURIComponent(before)}&select=tariff_id`,
      undefined,
      "return=representation",
    );
    return rows.length;
  }

  async findTariffs(peerId: string, ids: string[]): Promise<StoredTariff[]> {
    if (!ids.length) return [];
    const rows = await this.rest<TariffRow[]>(
      "GET",
      `emsp_ocpi_tariffs?peer_id=${eq(peerId)}&tariff_id=${inList(ids)}&select=peer_id,data,seen_at`,
    );
    return rows.map((r) => ({
      peerId: r.peer_id,
      tariff: r.data,
      seenAt: r.seen_at,
    }));
  }

  async getSyncState(
    peerId: string,
    module: SyncModule,
  ): Promise<SyncState | null> {
    const [row] = await this.rest<SyncRow[]>(
      "GET",
      `emsp_ocpi_sync_state?peer_id=${eq(peerId)}&module=${eq(module)}&select=*`,
    );
    return row
      ? {
          peerId: row.peer_id,
          module: row.module,
          lastFullSyncAt: row.last_full_sync_at,
          cursor: row.cursor,
          run: row.run,
          lastResult: row.last_result,
        }
      : null;
  }

  async saveSyncState(s: SyncState, expectedRunId: string | null) {
    const row = {
      last_full_sync_at: s.lastFullSyncAt,
      cursor: s.cursor,
      run_id: s.run?.id ?? null,
      run: s.run,
      last_result: s.lastResult,
      updated_at: new Date().toISOString(),
    };
    const key = `peer_id=${eq(s.peerId)}&module=${eq(s.module)}`;
    // Only if the run is still the one we expect: two syncs cannot both win.
    const updated = await this.rest<unknown[]>(
      "PATCH",
      `emsp_ocpi_sync_state?${key}&run_id=${expectedRunId === null ? "is.null" : eq(expectedRunId)}`,
      row,
      "return=representation",
    );
    if (updated.length) return true;
    if (expectedRunId !== null) return false;
    // No state yet: insert it, unless another sync inserted it first.
    const inserted = await this.rest<unknown[]>(
      "POST",
      "emsp_ocpi_sync_state?on_conflict=peer_id,module",
      { peer_id: s.peerId, module: s.module, ...row },
      "resolution=ignore-duplicates,return=representation",
    );
    return inserted.length > 0;
  }
}
