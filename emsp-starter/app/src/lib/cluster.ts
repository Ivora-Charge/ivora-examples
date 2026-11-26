import { boundsOf, distanceM, project, type Bounds, type LatLng } from "./geo";

export type Clustered<T> =
  | { kind: "point"; key: string; at: LatLng; item: T }
  | {
      kind: "cluster";
      key: string;
      at: LatLng;
      count: number;
      bounds: Bounds;
      items: T[];
      /** Every member is at one coordinate: no zoom can tell them apart. */
      sameSpot: boolean;
    };

/** Markers closer than this on screen are drawn as one cluster. */
export const CLUSTER_RADIUS_PX = 48;

/** From this zoom on, only places at one coordinate are still drawn as a cluster. */
export const CLUSTER_MAX_ZOOM = 16;

/**
 * Places this close (metres) count as one coordinate: it only absorbs rounding in the
 * source data, for example the same site sent with six and with seven decimals.
 */
export const SAME_SPOT_M = 1;

const sameSpot = (a: LatLng, b: LatLng) => distanceM(a, b) <= SAME_SPOT_M;

/**
 * Groups points that would overlap on screen at `zoom`. Greedy and stable: each point,
 * in the given order, takes every not-yet-taken point within `radiusPx` of it. From
 * `maxZoom` on, only points at the same spot as it are taken: their markers would lie
 * on top of each other, so one cluster stands for them (see `tapOpensChooser`).
 */
export function cluster<T extends { id: string; coordinates: LatLng }>(
  items: T[],
  zoom: number,
  radiusPx = CLUSTER_RADIUS_PX,
  maxZoom = CLUSTER_MAX_ZOOM,
): Clustered<T>[] {
  const z = Math.max(0, Math.min(22, zoom));
  const points = items.map((item) => ({
    item,
    px: project(item.coordinates, z),
  }));
  const taken = new Set<number>();
  const out: Clustered<T>[] = [];
  points.forEach((p, i) => {
    if (taken.has(i)) return;
    taken.add(i);
    const group = [p];
    points.forEach((q, j) => {
      if (taken.has(j)) return;
      if (
        sameSpot(p.item.coordinates, q.item.coordinates) ||
        (z < maxZoom &&
          Math.hypot(q.px.x - p.px.x, q.px.y - p.px.y) <= radiusPx)
      ) {
        taken.add(j);
        group.push(q);
      }
    });
    if (group.length === 1) {
      out.push({
        kind: "point",
        key: p.item.id,
        at: p.item.coordinates,
        item: p.item,
      });
      return;
    }
    const members = group.map((g) => g.item);
    const coords = members.map((m) => m.coordinates);
    out.push({
      kind: "cluster",
      key: `c:${members.map((m) => m.id).join("|")}`,
      at: {
        lat: coords.reduce((s, c) => s + c.lat, 0) / coords.length,
        lng: coords.reduce((s, c) => s + c.lng, 0) / coords.length,
      },
      count: members.length,
      bounds: boundsOf(coords)!,
      items: members,
      sameSpot: coords.every((c) => sameSpot(coords[0], c)),
    });
  });
  return out;
}

/**
 * The first half-step above `zoom` at which a cluster's places are no longer all one
 * cluster, `CLUSTER_MAX_ZOOM` at most. A press zooms in at least this far: where the
 * map has little room (a phone's, above its sheet), fitting the places in it could
 * leave the cluster as it was.
 */
export function splitZoom<T extends { id: string; coordinates: LatLng }>(
  items: T[],
  zoom: number,
): number {
  for (let z = zoom + 0.5; z < CLUSTER_MAX_ZOOM; z += 0.5)
    if (cluster(items, z).length > 1) return z;
  return CLUSTER_MAX_ZOOM;
}

/**
 * Whether a tap on a cluster lists its places instead of zooming in: zooming cannot
 * separate places at one coordinate, and past `CLUSTER_MAX_ZOOM` nothing is left to
 * zoom for.
 */
export function tapOpensChooser(
  group: { sameSpot: boolean },
  zoom: number,
): boolean {
  return group.sameSpot || zoom >= CLUSTER_MAX_ZOOM;
}
