import "server-only";
import { describeError, getIvora, IvoraError } from "./ivora";
import { getLive, isStaffSession } from "./live";
import { whToKwh } from "../units";

export interface Overview {
  mode: "live" | "demo";
  sites: number;
  chargers: number;
  online: number;
  connectors: number;
  activeSessions: number;
  /** Energy of the most recent sessions (up to 50), kWh. */
  recentEnergyKwh: number;
  /** Of those sessions, how many were started with the staff token (remote start, charger test). */
  staffSessions: number;
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
    const [sites, chargers, transactions] = await Promise.all([
      ivora.listAllLocations(),
      ivora.listAllStations(),
      ivora.listTransactions({ limit: 50 }),
    ]);
    const staffToken = operatorId
      ? ((await getLive().store.getStaffToken(operatorId))?.idToken ?? null)
      : null;
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
        activeSessions: transactions.filter((t) => t.active).length,
        recentEnergyKwh: whToKwh(energyWh),
        staffSessions: transactions.filter((t) => isStaffSession(t, staffToken))
          .length,
        stations: stations.map((s) => ({
          id: s.id,
          name: s.name,
          online: s.online,
          connectors: s.connectors.length,
        })),
        truncated: sites.truncated || chargers.truncated,
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
