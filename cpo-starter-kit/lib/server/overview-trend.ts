import "server-only";
import type { Staff } from "./team";
import {
  loadStats,
  parseReportQuery,
  reportTimeZone,
  type ReportsDeps,
  type StatsResult,
} from "./reports";

/**
 * The Overview's one chart: sessions' energy per day for the last 30 days, in the
 * company's time zone, else the sites' one shared zone, else UTC, as Reports picks it.
 * It reads the same `GET /locations` and `GET /stats` the Reports page does, with the
 * same 30-day preset: no new kind of Ivora call and no money figure. A failed sites
 * read only loses the fallback.
 */
export async function loadTrend(
  d: ReportsDeps,
  staff: Staff,
): Promise<{ zone: string; result: StatsResult }> {
  // The same fallback as Reports: the company's zone, else the one zone all sites share.
  const [profile, locations] = await Promise.all([
    d.company.load(staff.operatorId).catch(() => null),
    d.ivora.listAllLocations().catch(() => ({ data: [] })),
  ]);
  const { zone } = reportTimeZone(profile?.timeZone ?? null, locations.data);
  const { query } = parseReportQuery({ get: () => null }, zone, d.now());
  return { zone, result: await loadStats(d.ivora, query) };
}
