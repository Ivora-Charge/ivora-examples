export type LatLng = { lat: number; lng: number };
export type Bounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

/** Great-circle distance in metres. */
export function distanceM(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The smallest box holding every point, or undefined for none. */
export function boundsOf(points: LatLng[]): Bounds | undefined {
  if (!points.length) return undefined;
  return {
    west: Math.min(...points.map((p) => p.lng)),
    south: Math.min(...points.map((p) => p.lat)),
    east: Math.max(...points.map((p) => p.lng)),
    north: Math.max(...points.map((p) => p.lat)),
  };
}

/** A point in Web Mercator "world pixels" at a zoom level (256 px tiles). */
export function project(p: LatLng, zoom: number): { x: number; y: number } {
  const size = 256 * 2 ** zoom;
  const lat = Math.max(-85.05112878, Math.min(85.05112878, p.lat));
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((p.lng + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}
