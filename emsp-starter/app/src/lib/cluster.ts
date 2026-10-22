import { boundsOf, project, type Bounds, type LatLng } from "./geo";

export type Clustered<T> =
  | { kind: "point"; key: string; at: LatLng; item: T }
  | {
      kind: "cluster";
      key: string;
      at: LatLng;
      count: number;
      bounds: Bounds;
      items: T[];
    };

/** Markers closer than this on screen are drawn as one cluster. */
export const CLUSTER_RADIUS_PX = 48;

/**
 * Groups points that would overlap on screen at `zoom`. Greedy and stable: each point,
 * in the given order, takes every not-yet-taken point within `radiusPx` of it. Above
 * `maxZoom` nothing clusters, so every charger can be reached.
 */
export function cluster<T extends { id: string; coordinates: LatLng }>(
  items: T[],
  zoom: number,
  radiusPx = CLUSTER_RADIUS_PX,
  maxZoom = 16,
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
    if (z < maxZoom)
      points.forEach((q, j) => {
        if (taken.has(j)) return;
        if (Math.hypot(q.px.x - p.px.x, q.px.y - p.px.y) <= radiusPx) {
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
    });
  });
  return out;
}
