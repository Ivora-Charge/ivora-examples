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

/** The zone a charger's times are shown in: its site's, else the company's, else UTC. */
export function chargerZone(
  siteZone: string | null | undefined,
  companyZone: string | null | undefined,
): string {
  for (const z of [siteZone, companyZone]) if (z && validZone(z)) return z;
  return "UTC";
}

function validZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** "2026-01-02 10:31" in `zone`, 24-hour clock. */
function wall(ms: number, zone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(ms)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export interface ZonedTime {
  /** In the charger's zone: "2026-01-02 10:31". */
  local: string;
  zone: string;
  /** The same instant in UTC, as a secondary detail: "2026-01-02 15:31 UTC". */
  utc: string;
}

/** An instant in the charger's zone, with UTC beside it; null when there is none. */
export function zonedTime(iso: string | null, zone: string): ZonedTime | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const z = validZone(zone) ? zone : "UTC";
  return { local: wall(ms, z), zone: z, utc: `${wall(ms, "UTC")} UTC` };
}
