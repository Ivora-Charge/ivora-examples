import "server-only";
import { randomUUID } from "node:crypto";
import { dateTimeMs, type Location } from "@/lib/ocpi/locations";
import type { Tariff } from "@/lib/ocpi/tariffs";

/**
 * The cache of every peer's locations and tariffs. Objects are stored per peer, keyed by
 * country_code, party_id and id, so two CPOs that use the same IDs never overwrite each
 * other. `seenAt` is when the object last arrived (pulled or pushed); a full sync
 * removes what it did not see.
 */
export type ObjectKey = {
  peerId: string;
  countryCode: string;
  partyId: string;
  id: string;
};

export type StoredLocation = {
  peerId: string;
  location: Location;
  seenAt: string;
  /** Changes with every change of data: the compare-and-swap token for putLocation. */
  revision: string;
};
export type StoredTariff = {
  peerId: string;
  tariff: Tariff;
  seenAt: string;
  revision: string;
};

export type SyncModule = "locations" | "tariffs";
export type SyncMode = "full" | "incremental";

/** A pull in progress, or interrupted: enough to resume at the next page. */
export type SyncRun = {
  id: string;
  mode: SyncMode;
  startedAt: string;
  /** date_from of an incremental run. */
  dateFrom: string | null;
  /** The next page, from the peer's Link header. Null: start at the first page. */
  nextUrl: string | null;
  pages: number;
  items: number;
  invalid: number;
  /** Updated after every page. A run with an old heartbeat is resumed by the next sync. */
  heartbeatAt: string;
};

export type SyncResult = {
  ok: boolean;
  mode: SyncMode;
  finishedAt: string;
  items: number;
  invalid: number;
  removed: number;
  /** Safe to show: no tokens or peer data. */
  error?: string;
};

export type SyncState = {
  peerId: string;
  module: SyncModule;
  lastFullSyncAt: string | null;
  /** date_from for the next incremental sync. */
  cursor: string | null;
  run: SyncRun | null;
  lastResult: SyncResult | null;
};

/** A coarse filter the store applies; search.ts applies the exact one after it. */
export type CandidateFilter = {
  peerIds: string[];
  /** Bounding box; longitudes are left out when it would cross the antimeridian. */
  bbox?: { minLat: number; maxLat: number; minLng?: number; maxLng?: number };
  /** Lower-case words that must all appear in searchText(). */
  words?: string[];
  /** A normalised ID (searchIds()) the location must contain. */
  id?: string;
  /** The search point: candidates nearest to it come first, before the limit. */
  near?: { lat: number; lng: number };
  limit: number;
};

export interface LocationStore {
  getLocation(key: ObjectKey): Promise<StoredLocation | null>;
  /**
   * Stores a page of pulled locations, all with the same seenAt. A location held with a
   * newer last_updated (a push got there first) keeps its data, and only gets seenAt.
   */
  saveLocations(
    peerId: string,
    locations: Location[],
    seenAt: string,
  ): Promise<void>;
  /**
   * Writes one location only if it is unchanged since it was read: `expectedRevision`
   * is the revision read, or null when there was none (insert only). Returns false
   * when another write got there first; read again and retry.
   */
  putLocation(
    peerId: string,
    location: Location,
    seenAt: string,
    expectedRevision: string | null,
  ): Promise<boolean>;
  /** Removes a peer's locations last seen before `before`. Returns how many. */
  pruneLocations(peerId: string, before: string): Promise<number>;
  /**
   * Published locations matching the coarse filter, at most `limit`, nearest to
   * `filter.near` first when it is given.
   */
  findLocations(filter: CandidateFilter): Promise<StoredLocation[]>;

  getTariff(key: ObjectKey): Promise<StoredTariff | null>;
  /** Like saveLocations: a tariff held with a newer last_updated keeps its data. */
  saveTariffs(peerId: string, tariffs: Tariff[], seenAt: string): Promise<void>;
  /** Like putLocation. */
  putTariff(
    peerId: string,
    tariff: Tariff,
    seenAt: string,
    expectedRevision: string | null,
  ): Promise<boolean>;
  /** Deletes only if unchanged since read (`expectedRevision`). False: retry. */
  deleteTariff(key: ObjectKey, expectedRevision: string): Promise<boolean>;
  pruneTariffs(peerId: string, before: string): Promise<number>;
  /** The tariffs of one peer with these IDs (any party). */
  findTariffs(peerId: string, ids: string[]): Promise<StoredTariff[]>;

  getSyncState(peerId: string, module: SyncModule): Promise<SyncState | null>;
  /**
   * Saves the state only if its current run ID is still `expectedRunId` (null: no run
   * in progress, or no state yet). Returns false when another sync got there first.
   */
  saveSyncState(
    state: SyncState,
    expectedRunId: string | null,
  ): Promise<boolean>;
}

/** Text the search matches words against: name, address, postal code, city. */
export function searchText(l: Location): string {
  return [l.name, l.address, l.postal_code, l.city]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Upper-case letters and digits only, so "NL*ABC*E123" and "nlabce123" match. */
export const normaliseId = (s: string) =>
  s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** IDs a driver may type: location ID, EVSE uid, EVSE ID, the reference on the charger. */
export function searchIds(l: Location): string[] {
  const ids = new Set([normaliseId(l.id)]);
  for (const e of l.evses ?? [])
    for (const v of [e.uid, e.evse_id, e.physical_reference])
      if (v) ids.add(normaliseId(v));
  ids.delete("");
  return [...ids];
}

const key = (k: ObjectKey) =>
  JSON.stringify([
    k.peerId,
    k.countryCode.toUpperCase(),
    k.partyId.toUpperCase(),
    k.id,
  ]);

/**
 * A distance proxy that ranks like the great-circle distance at search radii
 * (equirectangular, longitudes wrapping at the antimeridian). The Supabase store orders
 * candidates by the same formula in SQL.
 */
export function nearness(
  from: { lat: number; lng: number },
  lat: number,
  lng: number,
): number {
  const dLng = Math.abs(lng - from.lng);
  const x = Math.min(dLng, 360 - dLng) * Math.cos((from.lat * Math.PI) / 180);
  return (lat - from.lat) ** 2 + x ** 2;
}

/** Whether the held object stays: it is newer than the pulled one. */
const heldIsNewer = (
  held: { last_updated: string },
  pulled: { last_updated: string },
) => dateTimeMs(held.last_updated) > dateTimeMs(pulled.last_updated);

/**
 * The cache in memory: demo mode (seeded with sample data) and tests. Each method reads
 * and writes without awaiting in between, so compare-and-swap holds within a process.
 */
export class MemoryLocationStore implements LocationStore {
  readonly locations = new Map<string, StoredLocation>();
  readonly tariffs = new Map<string, StoredTariff>();
  readonly sync = new Map<string, SyncState>();

  async getLocation(k: ObjectKey) {
    const l = this.locations.get(key(k));
    return l ? structuredClone(l) : null;
  }

  async saveLocations(peerId: string, locations: Location[], seenAt: string) {
    for (const location of locations) {
      const k = locationKey(peerId, location);
      const held = this.locations.get(k);
      if (held && heldIsNewer(held.location, location)) held.seenAt = seenAt;
      else
        this.locations.set(k, {
          peerId,
          location: structuredClone(location),
          seenAt,
          revision: randomUUID(),
        });
    }
  }

  async putLocation(
    peerId: string,
    location: Location,
    seenAt: string,
    expectedRevision: string | null,
  ) {
    const k = locationKey(peerId, location);
    if ((this.locations.get(k)?.revision ?? null) !== expectedRevision)
      return false;
    this.locations.set(k, {
      peerId,
      location: structuredClone(location),
      seenAt,
      revision: randomUUID(),
    });
    return true;
  }

  async pruneLocations(peerId: string, before: string) {
    return prune(this.locations, peerId, before);
  }

  async findLocations(f: CandidateFilter) {
    const out: StoredLocation[] = [];
    for (const s of this.locations.values()) {
      const l = s.location;
      if (!f.peerIds.includes(s.peerId) || !l.publish) continue;
      const lat = Number(l.coordinates.latitude);
      const lng = Number(l.coordinates.longitude);
      if (f.bbox && (lat < f.bbox.minLat || lat > f.bbox.maxLat)) continue;
      if (
        f.bbox?.minLng !== undefined &&
        (lng < f.bbox.minLng || lng > f.bbox.maxLng!)
      )
        continue;
      const text = searchText(l);
      if (f.words?.some((w) => !text.includes(w))) continue;
      if (f.id && !searchIds(l).includes(f.id)) continue;
      out.push(s);
    }
    const near = f.near;
    if (near) {
      const rank = (s: StoredLocation) =>
        nearness(
          near,
          Number(s.location.coordinates.latitude),
          Number(s.location.coordinates.longitude),
        );
      out.sort((a, b) => rank(a) - rank(b));
    }
    return out.slice(0, f.limit).map((s) => structuredClone(s));
  }

  async getTariff(k: ObjectKey) {
    const t = this.tariffs.get(key(k));
    return t ? structuredClone(t) : null;
  }

  async saveTariffs(peerId: string, tariffs: Tariff[], seenAt: string) {
    for (const tariff of tariffs) {
      const k = tariffKey(peerId, tariff);
      const held = this.tariffs.get(k);
      if (held && heldIsNewer(held.tariff, tariff)) held.seenAt = seenAt;
      else
        this.tariffs.set(k, {
          peerId,
          tariff: structuredClone(tariff),
          seenAt,
          revision: randomUUID(),
        });
    }
  }

  async putTariff(
    peerId: string,
    tariff: Tariff,
    seenAt: string,
    expectedRevision: string | null,
  ) {
    const k = tariffKey(peerId, tariff);
    if ((this.tariffs.get(k)?.revision ?? null) !== expectedRevision)
      return false;
    this.tariffs.set(k, {
      peerId,
      tariff: structuredClone(tariff),
      seenAt,
      revision: randomUUID(),
    });
    return true;
  }

  async deleteTariff(k: ObjectKey, expectedRevision: string) {
    if (this.tariffs.get(key(k))?.revision !== expectedRevision) return false;
    this.tariffs.delete(key(k));
    return true;
  }

  async pruneTariffs(peerId: string, before: string) {
    return prune(this.tariffs, peerId, before);
  }

  async findTariffs(peerId: string, ids: string[]) {
    return [...this.tariffs.values()]
      .filter((t) => t.peerId === peerId && ids.includes(t.tariff.id))
      .map((t) => structuredClone(t));
  }

  async getSyncState(peerId: string, module: SyncModule) {
    const s = this.sync.get(`${peerId}:${module}`);
    return s ? structuredClone(s) : null;
  }

  async saveSyncState(state: SyncState, expectedRunId: string | null) {
    const k = `${state.peerId}:${state.module}`;
    const current = this.sync.get(k);
    if ((current?.run?.id ?? null) !== expectedRunId) return false;
    this.sync.set(k, structuredClone(state));
    return true;
  }
}

const locationKey = (peerId: string, l: Location) =>
  key({ peerId, countryCode: l.country_code, partyId: l.party_id, id: l.id });
const tariffKey = (peerId: string, t: Tariff) =>
  key({ peerId, countryCode: t.country_code, partyId: t.party_id, id: t.id });

function prune(
  map: Map<string, { peerId: string; seenAt: string }>,
  peerId: string,
  before: string,
): number {
  let removed = 0;
  for (const [k, v] of map)
    if (v.peerId === peerId && Date.parse(v.seenAt) < Date.parse(before)) {
      map.delete(k);
      removed++;
    }
  return removed;
}
