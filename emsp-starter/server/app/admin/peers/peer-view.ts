import type { ModuleSync, PeerSummary } from "./actions";

/** How the admin web words a peer, from what the peer list gives today. */
export type PeerView = {
  tag: "Hub" | "CPO" | "Peer";
  state: { kind: "ok" | "todo" | "bad" | "done"; text: string };
  failing: ModuleSync[];
  trusted: number;
  offered: number;
  /** The newest pull of any module; null: never pulled. */
  lastPullAt: string | null;
};

const STATUS: Record<PeerSummary["status"], PeerView["state"]> = {
  registered: { kind: "ok", text: "Registered" },
  pending: { kind: "todo", text: "Registration not finished" },
  unregistered: { kind: "done", text: "Unregistered" },
  failed: { kind: "bad", text: "Registration failed" },
};

/** "locations@NL-ABC" as "Locations of NL-ABC". */
export function moduleName(key: string): string {
  const [module, party] = key.split("@");
  const name =
    module === "cdrs" ? "CDRs" : module[0].toUpperCase() + module.slice(1);
  return party ? `${name} of ${party}` : name;
}

export function viewOf(p: PeerSummary): PeerView {
  const failing = (p.sync ?? []).filter((m) => m.ok === false);
  const parties = p.hub?.parties ?? [];
  const pulls = (p.sync ?? [])
    .map((m) => m.lastPullAt)
    .filter((t): t is string => t !== null)
    .sort();
  const state =
    p.status === "registered" && failing.length
      ? {
          kind: "bad" as const,
          text: `${moduleName(failing[0].module)} pull failing`,
        }
      : p.status === "pending" && p.direction === "inbound"
        ? { kind: "todo" as const, text: "Waiting for them to register" }
        : STATUS[p.status];
  return {
    tag: p.hub ? "Hub" : p.parties.length ? "CPO" : "Peer",
    state,
    failing,
    trusted: parties.filter((h) => h.status === "trusted").length,
    offered: parties.filter((h) => h.status === "offered").length,
    lastPullAt: pulls.at(-1) ?? null,
  };
}

/** "4 times in a row", or "" for a first failure or an old record without a count. */
export function inARow(m: Pick<ModuleSync, "failures">): string {
  return m.failures && m.failures > 1 ? `${m.failures} times in a row` : "";
}

/** What to send the CPO about a failed pull, with the request ID when one was kept. */
export function sendTheCpo(m: Pick<ModuleSync, "requestId">): string {
  return m.requestId
    ? `Send the CPO the time and this request ID: ${m.requestId}.`
    : "";
}

/** "12 Nov 2026" in UTC, or "" when the time is not known (accepted before it was kept). */
export function sinceDay(iso: string | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms)
    ? ""
    : new Date(ms).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
}
