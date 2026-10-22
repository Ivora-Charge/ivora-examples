import type { EvseStatus, LocationSummary } from "./types";

/**
 * The four states a driver sees. Never shown by colour alone: each has its own tile
 * shape and glyph (see docs/brief/BRIEF.md) and its word is always printed.
 * - free: filled tile, filled dot
 * - busy: outlined tile, half dot
 * - down: hatched outlined tile, cross
 * - unknown: dashed outline
 */
export type StatusKind = "free" | "busy" | "down" | "unknown";

export function evseKind(s: EvseStatus): StatusKind {
  switch (s) {
    case "AVAILABLE":
      return "free";
    case "CHARGING":
    case "BLOCKED":
    case "RESERVED":
      return "busy";
    case "OUTOFORDER":
    case "INOPERATIVE":
      return "down";
    default:
      return "unknown";
  }
}

/**
 * A place as a whole: free when any charger is free, else busy when one is in use,
 * else down when every charger is out of order, else unknown.
 */
export function placeKind(
  l: Pick<LocationSummary, "available_count" | "status_counts">,
): StatusKind {
  if (l.available_count > 0) return "free";
  const counts = Object.entries(l.status_counts ?? {}) as [
    EvseStatus,
    number,
  ][];
  const kinds = counts.filter(([, n]) => n > 0).map(([s]) => evseKind(s));
  if (kinds.includes("busy")) return "busy";
  if (kinds.length && kinds.every((k) => k === "down")) return "down";
  return "unknown";
}
