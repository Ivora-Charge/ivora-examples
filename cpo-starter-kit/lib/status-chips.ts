/**
 * One vocabulary for status everywhere: a word, plus a shape and colour from the tone.
 * (ok = a circle, off = a square, warn = a triangle, busy = a diamond, live = lime
 * fill, idle = a ring.) Never colour alone.
 */
export type ChipTone = "ok" | "off" | "warn" | "busy" | "live" | "idle";

export interface ChipSpec {
  label: string;
  tone: ChipTone;
}

const IN_USE = new Set([
  "Preparing",
  "Charging",
  "SuspendedEV",
  "SuspendedEVSE",
  "Finishing",
  "Reserved",
]);

/** A connector's status as the charger reports it. */
export function connectorChip(status: string): ChipSpec {
  if (status === "Available") return { label: status, tone: "ok" };
  if (IN_USE.has(status)) return { label: status, tone: "busy" };
  if (status === "Faulted") return { label: status, tone: "warn" };
  return { label: status, tone: "off" };
}

export const STATION_CHIPS = {
  online: { label: "Online", tone: "ok" },
  offline: { label: "Offline", tone: "off" },
  faulted: { label: "Faulted", tone: "warn" },
} as const satisfies Record<string, ChipSpec>;

export const PHASE_CHIPS = {
  pending: { label: "Waiting for answer", tone: "busy" },
  accepted: { label: "Accepted", tone: "ok" },
  failed: { label: "Not done", tone: "off" },
  unknown: { label: "Outcome unknown", tone: "warn" },
} as const satisfies Record<string, ChipSpec>;
