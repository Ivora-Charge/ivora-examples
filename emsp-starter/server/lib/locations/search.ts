import "server-only";
import {
  CONNECTOR_TYPES,
  connectorPowerW,
  EVSE_STATUSES,
  FACILITIES,
  PARKING_RESTRICTIONS,
  type Connector,
  type ConnectorType,
  type Evse,
  type EvseStatus,
  type Facility,
  type Location,
  type ParkingRestriction,
} from "@/lib/ocpi/locations";
import type { Tariff } from "@/lib/ocpi/tariffs";
import {
  displayPrice,
  isFreeTariff,
  primaryTariff,
  type DisplayPrice,
} from "./pricing";
import {
  normaliseId,
  searchText,
  type CandidateFilter,
  type LocationStore,
  type ObjectKey,
  type StoredLocation,
} from "./store";

/**
 * The location search behind the app's API. The store narrows the candidates (peer,
 * published, bounding box, words, ID), nearest first, up to SEARCH_LIMITS.candidates;
 * this file applies the exact filters, sorts,
 * pages and shapes the results. Locations of peers that are not registered, unpublished
 * locations and REMOVED EVSEs never appear.
 */

export const SEARCH_LIMITS = {
  defaultRadiusM: 5_000,
  maxRadiusM: 50_000,
  defaultLimit: 20,
  maxLimit: 100,
  maxOffset: 10_000,
  /** The most candidates read from the store per search: Supabase's default Max rows. */
  candidates: 1_000,
} as const;

export type SearchQuery = {
  near?: { lat: number; lng: number; radiusM: number };
  /** Words that must all appear in the name or address. */
  text?: string;
  /** An EVSE ID, for example NL*ABC*E12345 (separators and case ignored). */
  evseId?: string;
  /** A charger's printed reference, EVSE uid or location ID. */
  chargerId?: string;
  /** At least one EVSE in one of these statuses. */
  status?: EvseStatus[];
  minPowerKw?: number;
  maxPowerKw?: number;
  /** At least one connector of one of these standards. */
  connectors?: ConnectorType[];
  /** The location has every one of these facilities. */
  facilities?: Facility[];
  /** An EVSE with every one of these parking restrictions (for example DISABLED). */
  parking?: ParkingRestriction[];
  /** An EVSE with none of these parking restrictions (for example CUSTOMERS). */
  excludeParking?: ParkingRestriction[];
  price?: "free" | "paid";
  limit: number;
  offset: number;
};

export class SearchQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchQueryError";
  }
}

function list<T extends string>(
  q: URLSearchParams,
  name: string,
  values: readonly T[],
  caseInsensitive = true,
): T[] | undefined {
  const raw = q.getAll(name).flatMap((v) => v.split(","));
  const items = raw.map((v) => v.trim()).filter(Boolean);
  if (!items.length) return undefined;
  return items.map((v) => {
    const found = values.find((x) =>
      caseInsensitive ? x.toUpperCase() === v.toUpperCase() : x === v,
    );
    if (!found) throw new SearchQueryError(`${name} has an unknown value`);
    return found;
  });
}

function number(
  q: URLSearchParams,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const v = q.get(name)?.trim();
  if (!v) return undefined;
  const n = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  if (!(n >= min && n <= max))
    throw new SearchQueryError(
      `${name} must be a number from ${min} to ${max}`,
    );
  return n;
}

function text(q: URLSearchParams, name: string, max: number) {
  const v = q.get(name)?.trim();
  if (!v) return undefined;
  if (v.length > max || /[\x00-\x1f\x7f]/.test(v))
    throw new SearchQueryError(`${name} must be at most ${max} characters`);
  return v;
}

/** Reads the API's query string. Throws SearchQueryError with a message for the caller. */
export function parseSearchQuery(q: URLSearchParams): SearchQuery {
  const lat = number(q, "lat", -90, 90);
  const lng = number(q, "lng", -180, 180);
  if ((lat === undefined) !== (lng === undefined))
    throw new SearchQueryError("lat and lng go together");
  const radiusM = number(q, "radius_m", 1, SEARCH_LIMITS.maxRadiusM);
  if (radiusM !== undefined && lat === undefined)
    throw new SearchQueryError("radius_m needs lat and lng");
  const price = q.get("price")?.trim().toLowerCase() || undefined;
  if (price && price !== "free" && price !== "paid")
    throw new SearchQueryError("price must be free or paid");
  const query: SearchQuery = {
    text: text(q, "q", 100),
    evseId: text(q, "evse_id", 48),
    chargerId: text(q, "charger_id", 36),
    status: list(q, "status", EVSE_STATUSES),
    minPowerKw: number(q, "min_power_kw", 0, 10_000),
    maxPowerKw: number(q, "max_power_kw", 0, 10_000),
    connectors: list(q, "connector", CONNECTOR_TYPES),
    facilities: list(q, "facility", FACILITIES),
    parking: list(q, "parking", PARKING_RESTRICTIONS),
    excludeParking: list(q, "exclude_parking", PARKING_RESTRICTIONS),
    price: price as SearchQuery["price"],
    limit:
      number(q, "limit", 1, SEARCH_LIMITS.maxLimit) ??
      SEARCH_LIMITS.defaultLimit,
    offset: number(q, "offset", 0, SEARCH_LIMITS.maxOffset) ?? 0,
  };
  if (!Number.isInteger(query.limit) || !Number.isInteger(query.offset))
    throw new SearchQueryError("limit and offset must be whole numbers");
  if (lat !== undefined && lng !== undefined)
    query.near = {
      lat,
      lng,
      radiusM: radiusM ?? SEARCH_LIMITS.defaultRadiusM,
    };
  for (const k of Object.keys(query) as (keyof SearchQuery)[])
    if (query[k] === undefined) delete query[k];
  return query;
}

/** Great-circle distance in metres. */
export function distanceM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A box around a point that holds every point within `radiusM`. */
export function boundingBox(lat: number, lng: number, radiusM: number) {
  const dLat = radiusM / 111_320;
  const minLat = Math.max(-90, lat - dLat);
  const maxLat = Math.min(90, lat + dLat);
  const cos = Math.cos((lat * Math.PI) / 180);
  const dLng = cos > 0.01 ? radiusM / (111_320 * cos) : 360;
  if (
    dLng >= 180 ||
    lng - dLng < -180 ||
    lng + dLng > 180 ||
    maxLat >= 89 ||
    minLat <= -89
  )
    return { minLat, maxLat };
  return { minLat, maxLat, minLng: lng - dLng, maxLng: lng + dLng };
}

/** Words of a text query, lower case, letters and digits only. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0)
    .slice(0, 8);
}

/** The app's ID for a location: opaque, unique across peers. */
export function locationAppId(k: ObjectKey): string {
  return Buffer.from(
    JSON.stringify([k.peerId, k.countryCode, k.partyId, k.id]),
  ).toString("base64url");
}

export function parseLocationAppId(id: string): ObjectKey | undefined {
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(id)) return undefined;
  try {
    const v = JSON.parse(Buffer.from(id, "base64url").toString("utf8"));
    if (
      Array.isArray(v) &&
      v.length === 4 &&
      v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 64)
    )
      return { peerId: v[0], countryCode: v[1], partyId: v[2], id: v[3] };
  } catch {}
  return undefined;
}

const coords = (l: Location) => ({
  lat: Number(l.coordinates.latitude),
  lng: Number(l.coordinates.longitude),
});

const visibleEvses = (l: Location) =>
  (l.evses ?? []).filter((e) => e.status !== "REMOVED");

function connectorMatches(
  c: Connector,
  q: SearchQuery,
  tariffs: Tariff[],
  now: Date,
): boolean {
  const kw = connectorPowerW(c) / 1000;
  if (q.minPowerKw !== undefined && kw < q.minPowerKw) return false;
  if (q.maxPowerKw !== undefined && kw > q.maxPowerKw) return false;
  if (q.connectors && !q.connectors.includes(c.standard)) return false;
  if (q.price) {
    const t = primaryTariff(c.tariff_ids, tariffs, now);
    // No known tariff: neither free nor paid.
    if (!t || isFreeTariff(t) !== (q.price === "free")) return false;
  }
  return true;
}

function evseMatches(
  e: Evse,
  q: SearchQuery,
  tariffs: Tariff[],
  now: Date,
): boolean {
  if (q.status && !q.status.includes(e.status)) return false;
  const restrictions = e.parking_restrictions ?? [];
  if (q.parking?.some((p) => !restrictions.includes(p))) return false;
  if (q.excludeParking?.some((p) => restrictions.includes(p))) return false;
  if (q.evseId && normaliseId(e.evse_id ?? "") !== normaliseId(q.evseId))
    return false;
  return e.connectors.some((c) => connectorMatches(c, q, tariffs, now));
}

function chargerMatches(l: Location, e: Evse, id: string): boolean {
  const n = normaliseId(id);
  return [l.id, e.uid, e.evse_id, e.physical_reference].some(
    (v) => v !== undefined && normaliseId(v) === n,
  );
}

export type LocationSummary = {
  id: string;
  name: string;
  address: string;
  postal_code?: string;
  city: string;
  country: string;
  coordinates: { lat: number; lng: number };
  /** From the search point, when the search had one. */
  distance_m?: number;
  operator?: string;
  facilities: Facility[];
  parking_type?: Location["parking_type"];
  time_zone: string;
  opening_times?: Location["opening_times"];
  evse_count: number;
  available_count: number;
  /** EVSEs matching the search filters. */
  matching_evse_count: number;
  max_power_kw: number;
  connector_standards: ConnectorType[];
  /** From the cheapest-looking connector tariff; null when no tariff is known. */
  price: { free: boolean; summary: string } | null;
  last_updated: string;
};

export type ConnectorDetail = {
  id: string;
  standard: ConnectorType;
  format: Connector["format"];
  power_type: Connector["power_type"];
  max_power_kw: number;
  price: DisplayPrice | null;
  terms_and_conditions?: string;
};

export type EvseDetail = {
  uid: string;
  evse_id?: string;
  status: EvseStatus;
  physical_reference?: string;
  floor_level?: string;
  capabilities: NonNullable<Evse["capabilities"]>;
  parking_restrictions: ParkingRestriction[];
  directions?: Evse["directions"];
  connectors: ConnectorDetail[];
};

export type LocationDetail = LocationSummary & {
  directions?: Location["directions"];
  charging_when_closed?: boolean;
  evses: EvseDetail[];
};

const kw = (w: number) => Math.round(w / 100) / 10;

function priceOf(
  c: Connector,
  tariffs: Tariff[],
  now: Date,
): DisplayPrice | null {
  const t = primaryTariff(c.tariff_ids, tariffs, now);
  return t ? displayPrice(t) : null;
}

function summarise(
  s: StoredLocation,
  tariffs: Tariff[],
  matching: number,
  now: Date,
  from?: { lat: number; lng: number },
): LocationSummary {
  const l = s.location;
  const evses = visibleEvses(l);
  const connectors = evses.flatMap((e) => e.connectors);
  const prices = connectors
    .map((c) => primaryTariff(c.tariff_ids, tariffs, now))
    .filter((t): t is Tariff => !!t);
  const free = prices.find(isFreeTariff);
  const shown = free ?? prices[0];
  const summary: LocationSummary = {
    id: locationAppId({
      peerId: s.peerId,
      countryCode: l.country_code,
      partyId: l.party_id,
      id: l.id,
    }),
    name: l.name ?? l.address,
    address: l.address,
    city: l.city,
    country: l.country,
    coordinates: coords(l),
    facilities: l.facilities ?? [],
    time_zone: l.time_zone,
    evse_count: evses.length,
    available_count: evses.filter((e) => e.status === "AVAILABLE").length,
    matching_evse_count: matching,
    max_power_kw: kw(Math.max(0, ...connectors.map(connectorPowerW))),
    connector_standards: [...new Set(connectors.map((c) => c.standard))],
    price: shown
      ? { free: isFreeTariff(shown), summary: displayPrice(shown).summary }
      : null,
    last_updated: l.last_updated,
  };
  if (l.postal_code) summary.postal_code = l.postal_code;
  if (from) summary.distance_m = Math.round(distanceM(from, coords(l)));
  if (l.operator) summary.operator = l.operator.name;
  if (l.parking_type) summary.parking_type = l.parking_type;
  if (l.opening_times) summary.opening_times = l.opening_times;
  return summary;
}

export function locationDetail(
  s: StoredLocation,
  tariffs: Tariff[],
  now = new Date(),
): LocationDetail {
  const l = s.location;
  const evses = visibleEvses(l);
  const detail: LocationDetail = {
    ...summarise(s, tariffs, evses.length, now),
    evses: evses.map((e) => {
      const d: EvseDetail = {
        uid: e.uid,
        status: e.status,
        capabilities: e.capabilities ?? [],
        parking_restrictions: e.parking_restrictions ?? [],
        connectors: e.connectors.map((c) => {
          const cd: ConnectorDetail = {
            id: c.id,
            standard: c.standard,
            format: c.format,
            power_type: c.power_type,
            max_power_kw: kw(connectorPowerW(c)),
            price: priceOf(c, tariffs, now),
          };
          if (c.terms_and_conditions)
            cd.terms_and_conditions = c.terms_and_conditions;
          return cd;
        }),
      };
      if (e.evse_id) d.evse_id = e.evse_id;
      if (e.physical_reference) d.physical_reference = e.physical_reference;
      if (e.floor_level) d.floor_level = e.floor_level;
      if (e.directions) d.directions = e.directions;
      return d;
    }),
  };
  if (l.directions) detail.directions = l.directions;
  if (l.charging_when_closed !== undefined)
    detail.charging_when_closed = l.charging_when_closed;
  return detail;
}

/** The tariffs a set of locations refer to, by peer. */
export async function tariffsFor(
  store: LocationStore,
  locations: StoredLocation[],
): Promise<Map<string, Tariff[]>> {
  const ids = new Map<string, Set<string>>();
  for (const s of locations)
    for (const e of s.location.evses ?? [])
      for (const c of e.connectors)
        for (const t of c.tariff_ids ?? []) {
          if (!ids.has(s.peerId)) ids.set(s.peerId, new Set());
          ids.get(s.peerId)!.add(t);
        }
  const out = new Map<string, Tariff[]>();
  for (const [peerId, set] of ids)
    out.set(
      peerId,
      (await store.findTariffs(peerId, [...set])).map((t) => t.tariff),
    );
  return out;
}

/**
 * A location's tariffs: those of the same peer and the same party. Tariff IDs are
 * unique only per country_code and party_id, so another party's tariff with the same
 * ID is a different tariff.
 */
export function tariffsOfLocation(
  s: StoredLocation,
  byPeer: Map<string, Tariff[]>,
): Tariff[] {
  return (byPeer.get(s.peerId) ?? []).filter(
    (t) =>
      t.country_code === s.location.country_code &&
      t.party_id === s.location.party_id,
  );
}

export type SearchResult = {
  items: LocationSummary[];
  /** Matches among the candidates read (at most SEARCH_LIMITS.candidates). */
  total: number;
  limit: number;
  offset: number;
};

export async function searchLocations(
  store: LocationStore,
  peerIds: string[],
  q: SearchQuery,
  now = new Date(),
): Promise<SearchResult> {
  const filter: CandidateFilter = {
    peerIds,
    limit: SEARCH_LIMITS.candidates,
  };
  if (q.near) {
    filter.bbox = boundingBox(q.near.lat, q.near.lng, q.near.radiusM);
    filter.near = { lat: q.near.lat, lng: q.near.lng };
  }
  if (q.text) filter.words = words(q.text);
  const id = q.evseId ?? q.chargerId;
  if (id) filter.id = normaliseId(id);
  const candidates = peerIds.length ? await store.findLocations(filter) : [];
  const byPeer = await tariffsFor(store, candidates);

  const hits: { s: StoredLocation; matching: number; distance?: number }[] = [];
  for (const s of candidates) {
    const l = s.location;
    if (!l.publish || !peerIds.includes(s.peerId)) continue;
    const distance = q.near ? distanceM(q.near, coords(l)) : undefined;
    if (q.near && distance! > q.near.radiusM) continue;
    if (q.text) {
      const t = searchText(l);
      if (!words(q.text).every((w) => t.includes(w))) continue;
    }
    if (q.facilities?.some((f) => !(l.facilities ?? []).includes(f))) continue;
    const tariffs = tariffsOfLocation(s, byPeer);
    const matching = visibleEvses(l).filter(
      (e) =>
        evseMatches(e, q, tariffs, now) &&
        (!q.chargerId || chargerMatches(l, e, q.chargerId)),
    ).length;
    if (matching === 0) continue;
    hits.push({ s, matching, distance });
  }
  hits.sort((a, b) =>
    a.distance !== undefined && b.distance !== undefined
      ? a.distance - b.distance
      : (a.s.location.name ?? a.s.location.address).localeCompare(
          b.s.location.name ?? b.s.location.address,
        ),
  );
  return {
    items: hits
      .slice(q.offset, q.offset + q.limit)
      .map((h) =>
        summarise(h.s, tariffsOfLocation(h.s, byPeer), h.matching, now, q.near),
      ),
    total: hits.length,
    limit: q.limit,
    offset: q.offset,
  };
}
