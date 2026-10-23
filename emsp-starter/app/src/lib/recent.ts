import type { LocationSummary } from "./types";

/**
 * Places the driver has just seen in a list, so a charger page can show its name at
 * once while the rest loads. In memory only.
 */
const seen = new Map<string, LocationSummary>();

export function remember(places: LocationSummary[]) {
  for (const p of places) seen.set(p.id, p);
  if (seen.size > 500) seen.clear();
}

export const recall = (id: string) => seen.get(id);
