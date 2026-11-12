/** Pure helpers for the Live screen: the status filter and the charger table rows. */

import type { StationView } from "@/lib/server/live/service";

export const LIVE_FILTERS = ["all", "charging", "faulted", "offline"] as const;
export type LiveFilter = (typeof LIVE_FILTERS)[number];

/** The `?status=` value, or "all" for anything else. */
export function parseLiveFilter(v: string | string[] | undefined): LiveFilter {
  return LIVE_FILTERS.find((f) => f === v) ?? "all";
}

/** Whether a charger belongs under a status filter. */
export function matchesLiveFilter(
  st: Pick<StationView, "state" | "sessions">,
  f: LiveFilter,
): boolean {
  switch (f) {
    case "all":
      return true;
    case "charging":
      return st.sessions.length > 0;
    case "faulted":
      return st.state === "faulted";
    case "offline":
      return st.state === "offline";
  }
}

/** Connectors free to use: Available and no session on them. */
export const freeConnectors = (st: Pick<StationView, "connectors">) =>
  st.connectors.filter((c) => c.status === "Available" && !c.session).length;

/** A link to Live with a status filter and, optionally, a selected charger. */
export function liveHref(f: LiveFilter, charger?: number | null): string {
  const q = new URLSearchParams();
  if (f !== "all") q.set("status", f);
  if (charger != null) q.set("charger", String(charger));
  const s = q.toString();
  return s ? `/live?${s}` : "/live";
}
