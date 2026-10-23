import { distanceM, type LatLng } from "./geo";
import { isOpenAt } from "./hours";
import type {
  ConnectorDetail,
  LocationDetail,
  LocationSummary,
  SearchResult,
} from "./types";

/** The filter chips. Each maps to the server's search parameters (see the server README). */
export type Filters = {
  openNow: boolean;
  available: boolean;
  minPowerKw: 0 | 22 | 50 | 150;
  connector: "" | "CCS" | "TYPE2" | "CHADEMO";
  stepFree: boolean;
  price: "" | "free" | "paid";
};

export const NO_FILTERS: Filters = {
  openNow: false,
  available: false,
  minPowerKw: 0,
  connector: "",
  stepFree: false,
  price: "",
};

export const CONNECTOR_STANDARDS: Record<
  Exclude<Filters["connector"], "">,
  string
> = {
  CCS: "IEC_62196_T2_COMBO",
  TYPE2: "IEC_62196_T2",
  CHADEMO: "CHADEMO",
};

export type Search = {
  text: string;
  filters: Filters;
  /** Search around here, nearest first. Without it: everything, by name. */
  near?: LatLng & { radiusM: number };
};

export const SEARCH_RADIUS_M = 25_000;
export const SEARCH_LIMIT = 100;

/**
 * What a search box entry is: an EVSE ID as printed on a charger (for example
 * NL*ABC*E12345), a charger's own reference or ID (one word with a digit), or words of
 * a place, street or site name.
 */
export function classify(
  text: string,
): { kind: "evse" | "charger" | "text"; value: string } | null {
  const value = text.trim().replace(/\s+/g, " ");
  if (!value) return null;
  if (
    /^[A-Za-z]{2}[*-]?[A-Za-z0-9]{3}[*-]?E[A-Za-z0-9*-]{1,30}$/i.test(value) &&
    /[\d*]/.test(value)
  )
    return { kind: "evse", value };
  if (!value.includes(" ") && /\d/.test(value) && /^[\w*.-]{2,36}$/.test(value))
    return { kind: "charger", value };
  return { kind: "text", value };
}

/** The server's query string for a search. "Open now" is applied by the app. */
export function searchParams(s: Search): URLSearchParams {
  const q = new URLSearchParams();
  const entry = classify(s.text);
  if (entry?.kind === "evse") q.set("evse_id", entry.value);
  else if (entry?.kind === "charger") q.set("charger_id", entry.value);
  else if (entry) q.set("q", entry.value.slice(0, 100));
  const f = s.filters;
  if (f.available) q.set("status", "AVAILABLE");
  if (f.minPowerKw) q.set("min_power_kw", String(f.minPowerKw));
  if (f.connector) q.set("connector", CONNECTOR_STANDARDS[f.connector]);
  if (f.stepFree) q.set("parking", "DISABLED");
  if (f.price) q.set("price", f.price);
  if (s.near) {
    q.set("lat", s.near.lat.toFixed(6));
    q.set("lng", s.near.lng.toFixed(6));
    q.set("radius_m", String(Math.round(s.near.radiusM)));
  }
  q.set("limit", String(SEARCH_LIMIT));
  return q;
}

/** Applies what the server does not: "Open now". */
export function openNowFilter(
  items: LocationSummary[],
  f: Filters,
  now = new Date(),
): LocationSummary[] {
  return f.openNow
    ? items.filter((l) => isOpenAt(l.opening_times, l.time_zone, now) !== false)
    : items;
}

export const normaliseId = (v: string) =>
  v.toUpperCase().replace(/[^A-Z0-9]/g, "");

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

function connectorMatches(c: ConnectorDetail, f: Filters): boolean {
  if (f.minPowerKw && c.max_power_kw < f.minPowerKw) return false;
  if (f.connector && c.standard !== CONNECTOR_STANDARDS[f.connector])
    return false;
  if (f.price) {
    if (!c.price || c.price.free !== (f.price === "free")) return false;
  }
  return true;
}

/** The location without its EVSEs, as a search result shows it. */
export function summaryOf(
  l: LocationDetail,
  matching: number,
  distance?: number,
): LocationSummary {
  const {
    evses: _evses,
    directions: _d,
    charging_when_closed: _c,
    ...rest
  } = l;
  const s: LocationSummary = { ...rest, matching_evse_count: matching };
  if (distance !== undefined) s.distance_m = Math.round(distance);
  return s;
}

/**
 * The offline demo's search, over the sample locations: the same rules as the
 * server's search, so the demo behaves like a server in demo mode.
 */
export function searchSample(
  locations: LocationDetail[],
  s: Search,
): SearchResult {
  const entry = classify(s.text);
  const f = s.filters;
  const hits: { l: LocationDetail; matching: number; distance?: number }[] = [];
  for (const l of locations) {
    const distance = s.near ? distanceM(s.near, l.coordinates) : undefined;
    if (s.near && distance! > s.near.radiusM) continue;
    if (entry?.kind === "text") {
      const hay = words(
        [l.name, l.address, l.postal_code, l.city].filter(Boolean).join(" "),
      ).join(" ");
      if (!words(entry.value).every((w) => hay.includes(w))) continue;
    }
    const matching = l.evses.filter((e) => {
      if (f.available && e.status !== "AVAILABLE") return false;
      if (f.stepFree && !e.parking_restrictions.includes("DISABLED"))
        return false;
      if (entry?.kind === "evse" || entry?.kind === "charger") {
        const id = normaliseId(entry.value);
        const ids =
          entry.kind === "evse"
            ? [e.evse_id]
            : [l.id, e.uid, e.evse_id, e.physical_reference];
        if (!ids.some((v) => v !== undefined && normaliseId(v) === id))
          return false;
      }
      return e.connectors.some((c) => connectorMatches(c, f));
    }).length;
    if (matching === 0) continue;
    hits.push({ l, matching, distance });
  }
  hits.sort((a, b) =>
    a.distance !== undefined && b.distance !== undefined
      ? a.distance - b.distance
      : a.l.name.localeCompare(b.l.name),
  );
  const items = hits
    .slice(0, SEARCH_LIMIT)
    .map((h) => summaryOf(h.l, h.matching, h.distance));
  return {
    mode: "demo",
    items,
    total: hits.length,
    limit: SEARCH_LIMIT,
    offset: 0,
  };
}
