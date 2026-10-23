import "server-only";
import { describeError, getIvora, IvoraError } from "./ivora";
import { getLive, isFreeSession, isStaffSession, running } from "./live";
import { asTransaction, syncActiveSessions } from "./live/active";
import { whToKwh } from "../units";

export interface Overview {
  mode: "live" | "demo";
  sites: number;
  chargers: number;
  online: number;
  connectors: number;
  activeSessions: number;
  /** Energy delivered so far by the sessions charging now, kWh. */
  activeEnergyKwh: number;
  /** Of those sessions, how many were started with the staff token (remote start, charger test). */
  staffSessions: number;
  /** Of those, how many were free driver sessions (the free charging token). */
  freeSessions: number;
  /** False when the session tracking left work for later (as on Live): the counts may lag. */
  sessionsComplete: boolean;
  stations: { id: number; name: string; online: boolean; connectors: number }[];
  /** More sites or chargers than the client pages through: counts are a lower bound. */
  truncated: boolean;
}

export type OverviewResult =
  | { ok: true; overview: Overview }
  | { ok: false; mode: "live" | "demo"; error: string };

/** What the Overview page shows. Reads only; works the same in demo and live mode. */
export async function loadOverview(
  operatorId?: string,
): Promise<OverviewResult> {
  const ivora = getIvora();
  try {
    const [sites, chargers] = await Promise.all([
      ivora.listAllLocations(),
      ivora.listAllStations(),
    ]);
    const live = getLive();
    const store = live.store;
    // Ivora lists transactions oldest first, so the newest page is not "now": the
    // running sessions come from Live's tracker (see lib/server/live/active.ts), which
    // shares its throttle and budget with the Live page.
    const sync = await syncActiveSessions(
      live,
      chargers.data.map((s) => s.id),
    );
    const transactions = sync.sessions.map(asTransaction).filter(running);
    const [staff, free] = operatorId
      ? await Promise.all([
          store.getStaffToken(operatorId),
          store.getFreeToken(operatorId),
        ])
      : [null, null];
    const staffToken = staff?.idToken ?? null;
    const freeToken = free?.idToken ?? null;
    const locations = sites.data;
    const stations = chargers.data;
    const energyWh = transactions.reduce((n, t) => n + (t.energy_wh ?? 0), 0);
    return {
      ok: true,
      overview: {
        mode: ivora.mode,
        sites: locations.length,
        chargers: stations.length,
        online: stations.filter((s) => s.online).length,
        connectors: stations.reduce((n, s) => n + s.connectors.length, 0),
        activeSessions: transactions.length,
        activeEnergyKwh: whToKwh(energyWh),
        staffSessions: transactions.filter((t) => isStaffSession(t, staffToken))
          .length,
        freeSessions: transactions.filter((t) => isFreeSession(t, freeToken))
          .length,
        stations: stations.map((s) => ({
          id: s.id,
          name: s.name,
          online: s.online,
          connectors: s.connectors.length,
        })),
        truncated: sites.truncated || chargers.truncated,
        sessionsComplete: sync.complete,
      },
    };
  } catch (e) {
    // Code and request ID only: never the key, tenant ID or response body.
    console.error(
      "cpo-starter-kit: overview failed:",
      e instanceof IvoraError
        ? `${e.code} (HTTP ${e.status}) ${e.requestId ?? ""}`
        : e instanceof Error
          ? e.name
          : "error",
    );
    return { ok: false, mode: ivora.mode, error: describeError(e) };
  }
}
