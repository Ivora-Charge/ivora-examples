import "server-only";
import { parseHostFilter, type HostFilter } from "@/lib/hosts";
import { HOST_ROLE } from "@/lib/roles";
import { filterScope, type SiteScope } from "../scope";
import type { Staff } from "../team/types";
import { hostDirectory } from "./service";
import type { HostStore } from "./types";

export interface HostFilterView {
  /** The filter as applied (an unknown or archived host reads as every site). */
  filter: HostFilter;
  scope: SiteScope | null;
  /** The select's options: value and label. Empty when there are no hosts. */
  options: [string, string][];
  /** What the page shows, for example "Sample Host A". Null for every site. */
  label: string | null;
}

const NONE: HostFilterView = {
  filter: { kind: "all" },
  scope: null,
  options: [],
  label: null,
};

/**
 * The host filter of Chargers, Live and Reports, for operator staff: `?host=` is a
 * host's ID or `own` (sites of no host). A host user gets none: their own scope
 * applies whatever the URL says. A display choice only; access is the scope's.
 */
export async function loadHostFilter(
  store: HostStore,
  staff: Staff,
  raw: string | string[] | undefined,
): Promise<HostFilterView> {
  if (staff.role === HOST_ROLE) return NONE;
  let dir;
  try {
    dir = await hostDirectory(store, staff);
  } catch (e) {
    // The filter is optional: without it the page shows every site.
    console.error("cpo-starter-kit: host filter failed:", {
      error: e instanceof Error ? e.name : "error",
    });
    return NONE;
  }
  const active = dir.hosts.filter((h) => !h.archivedAt);
  if (!active.length) return NONE;
  let filter = parseHostFilter(raw);
  const host =
    filter.kind === "host"
      ? active.find((h) => h.id === (filter as { hostId: string }).hostId)
      : undefined;
  if (filter.kind === "host" && !host) filter = { kind: "all" };
  return {
    filter,
    scope: filterScope(filter, dir.sites),
    options: [
      ["own", "Your own sites (no host)"],
      ...active.map((h): [string, string] => [h.id, h.name]),
    ],
    label: filter.kind === "own" ? "your own sites" : host ? host.name : null,
  };
}
