/** Pure figures for the Chargers list and the charger page, so they can be tested without a DOM. */

import type { ChargerView } from "@/lib/server/chargers";

type Facts = Pick<ChargerView, "pending" | "missing" | "online" | "connectors">;

/** The status as a word; the same words the status chip shows. */
export function chargerStatusText(c: Facts): string {
  if (c.pending) return "Not registered yet";
  if (c.missing) return "Not in Ivora";
  return c.online ? "Online" : "Offline";
}

/** A charger that is not working normally: offline, not registered, gone from Ivora, or faulted. */
export function needsAttention(c: Facts): boolean {
  return (
    c.pending ||
    c.missing ||
    !c.online ||
    c.connectors.some((k) => k.status === "Faulted")
  );
}

/** Connectors that are free to use right now. */
export function freeConnectorCount(c: Pick<ChargerView, "connectors">): number {
  return c.connectors.filter((k) => k.status === "Available").length;
}

export function chargerCounts(chargers: Facts[]) {
  return {
    total: chargers.length,
    online: chargers.filter((c) => !c.pending && !c.missing && c.online).length,
    connectors: chargers.reduce((n, c) => n + c.connectors.length, 0),
    attention: chargers.filter(needsAttention).length,
  };
}

/** "31 s ago", "2 h ago" or "Never": a rough age for the summary strip. */
export function ago(iso: string | null, now = Date.now()) {
  if (!iso) return "Never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
