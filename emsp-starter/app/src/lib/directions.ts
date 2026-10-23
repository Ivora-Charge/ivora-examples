import type { LatLng } from "./geo";

/**
 * A link that opens turn-by-turn directions to a place in the device's own maps app,
 * or OpenStreetMap's route planner on the web. No key and no account.
 */
export function directionsUrl(
  to: LatLng,
  label: string,
  platform: string,
): string {
  const at = `${to.lat.toFixed(6)},${to.lng.toFixed(6)}`;
  const name = encodeURIComponent(label);
  if (platform === "ios")
    return `https://maps.apple.com/?daddr=${at}&q=${name}`;
  if (platform === "android") return `geo:${at}?q=${at}(${name})`;
  return `https://www.openstreetmap.org/directions?route=%3B${encodeURIComponent(at)}`;
}
