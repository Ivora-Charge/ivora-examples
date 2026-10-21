import "server-only";
import { randomUUID } from "node:crypto";
import { dateTimeMs, type Location } from "@/lib/ocpi/locations";
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

type LocationRow = {
  peer_id: string;
  data: Location;
  seen_at: string;
  revision: string;
};
type TariffRow = {
  peer_id: string;
  data: Tariff;
  seen_at: string;
  revision: string;
};
type SyncRow = {
  peer_id: string;
  module: SyncModule;
  last_full_sync_at: string | null;
  cursor: string | null;
  run_id: string | null;
  run: SyncState["run"];
  last_result: SyncState["lastResult"];
};

const ROW = "select=peer_id,data,seen_at,revision";

const keyFilter = (k: ObjectKey, idColumn: string) =>
  `peer_id=${eq(k.peerId)}&country_code=${eq(k.countryCode.toUpperCase())}&party_id=${eq(k.partyId.toUpperCase())}&${idColumn}=${eq(k.id)}`;

const location = (r: LocationRow): StoredLocation => ({
  peerId: r.peer_id,
  location: r.data,
  seenAt: r.seen_at,
  revision: r.revision,
});
const tariff = (r: TariffRow): StoredTariff => ({
  peerId: r.peer_id,
  tariff: r.data,
  seenAt: r.seen_at,
  revision: r.revision,
});

/** The columns of a location row, beside the key and seen_at. */
const locationColumns = (l: Location) => ({
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
});

const tariffColumns = (t: Tariff) => ({
  country_code: t.country_code,
  party_id: t.party_id,
  tariff_id: t.id,
  data: t,
  last_updated: t.last_updated,
});

/**
 * One object per key, the newest: one insert cannot change a row twice, and a page may
 * repeat an object.
 */
function newestPerKey<
  T extends {
    country_code: string;
    party_id: string;
    id: string;
    last_updated: string;
  },
>(objects: T[]): T[] {
  const out = new Map<string, T>();
  for (const o of objects) {
    const k = JSON.stringify([o.country_code, o.party_id, o.id]);
    const held = out.get(k);
    if (!held || dateTimeMs(o.last_updated) >= dateTimeMs(held.last_updated))
      out.set(k, o);
  }
  return [...out.values()];
}

/**
 * The locations and tariffs cache in Supabase Postgres (emsp_ocpi_locations,
 * emsp_ocpi_tariffs, emsp_ocpi_sync_state), through the Data API as the service role.
 * Each object is stored whole as jsonb, with the columns the search filters on beside it.
 *
 * Writes never lose a concurrent change: a push writes with compare-and-swap on the
 * row's revision (a PATCH that matches only the revision it read), and a pull stores a
 * page with emsp_ocpi_save_locations / _tariffs, which keep rows that are newer.
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
      `emsp_ocpi_locations?${keyFilter(k, "location_id")}&${ROW}`,
    );
    return row ? location(row) : null;
  }

  async saveLocations(peerId: string, locations: Location[], seenAt: string) {
    if (!locations.length) return;
    await this.rest("POST", "rpc/emsp_ocpi_save_locations", {
      p_peer_id: peerId,
      p_seen_at: seenAt,
      p_rows: newestPerKey(locations).map(locationColumns),
    });
  }

  async putLocation(
    peerId: string,
    l: Location,
    seenAt: string,
    expectedRevision: string | null,
  ) {
    const row = {
      ...locationColumns(l),
      seen_at: seenAt,
      updated_at: new Date().toISOString(),
      revision: randomUUID(),
    };
    return this.compareAndSwap(
      "emsp_ocpi_locations",
      keyFilter(
        {
          peerId,
          countryCode: l.country_code,
          partyId: l.party_id,
          id: l.id,
        },
        "location_id",
      ),
      { peer_id: peerId, ...row },
      expectedRevision,
      "peer_id,country_code,party_id,location_id",
    );
  }

  /**
   * Updates the row only while its revision is `expected`; with null, inserts it only
   * if there is none. True when this write won.
   */
  private async compareAndSwap(
    table: string,
    key: string,
    row: Record<string, unknown>,
    expected: string | null,
    conflict: string,
  ): Promise<boolean> {
    const written =
      expected === null
        ? await this.rest<unknown[]>(
            "POST",
            `${table}?on_conflict=${conflict}&select=revision`,
            row,
            "resolution=ignore-duplicates,return=representation",
          )
        : await this.rest<unknown[]>(
            "PATCH",
            `${table}?${key}&revision=${eq(expected)}&select=revision`,
            row,
            "return=representation",
          );
    return written.length > 0;
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
    // Ordered nearest first in the database, so the limit drops the farthest.
    const rows = await this.rest<LocationRow[]>(
      "POST",
      "rpc/emsp_ocpi_location_candidates",
      {
        p_peer_ids: f.peerIds,
        p_min_lat: f.bbox?.minLat ?? null,
        p_max_lat: f.bbox?.maxLat ?? null,
        p_min_lng: f.bbox?.minLng ?? null,
        p_max_lng: f.bbox?.maxLng ?? null,
        p_lat: f.near?.lat ?? null,
        p_lng: f.near?.lng ?? null,
        p_words: f.words?.length ? f.words : null,
        p_search_id: f.id ?? null,
        p_limit: f.limit,
      },
    );
    return rows.map(location);
  }

  async getTariff(k: ObjectKey): Promise<StoredTariff | null> {
    const [row] = await this.rest<TariffRow[]>(
      "GET",
      `emsp_ocpi_tariffs?${keyFilter(k, "tariff_id")}&${ROW}`,
    );
    return row ? tariff(row) : null;
  }

  async saveTariffs(peerId: string, tariffs: Tariff[], seenAt: string) {
    if (!tariffs.length) return;
    await this.rest("POST", "rpc/emsp_ocpi_save_tariffs", {
      p_peer_id: peerId,
      p_seen_at: seenAt,
      p_rows: newestPerKey(tariffs).map(tariffColumns),
    });
  }

  async putTariff(
    peerId: string,
    t: Tariff,
    seenAt: string,
    expectedRevision: string | null,
  ) {
    return this.compareAndSwap(
      "emsp_ocpi_tariffs",
      keyFilter(
        { peerId, countryCode: t.country_code, partyId: t.party_id, id: t.id },
        "tariff_id",
      ),
      {
        peer_id: peerId,
        ...tariffColumns(t),
        seen_at: seenAt,
        updated_at: new Date().toISOString(),
        revision: randomUUID(),
      },
      expectedRevision,
      "peer_id,country_code,party_id,tariff_id",
    );
  }

  async deleteTariff(k: ObjectKey, expectedRevision: string) {
    const rows = await this.rest<unknown[]>(
      "DELETE",
      `emsp_ocpi_tariffs?${keyFilter(k, "tariff_id")}&revision=${eq(expectedRevision)}&select=tariff_id`,
      undefined,
      "return=representation",
    );
    return rows.length > 0;
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
      `emsp_ocpi_tariffs?peer_id=${eq(peerId)}&tariff_id=${inList(ids)}&${ROW}`,
    );
    return rows.map(tariff);
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
