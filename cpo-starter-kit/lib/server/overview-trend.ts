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
 * company's time zone (UTC until it is set). It reads the same `GET /stats` the Reports
 * page does, with the same 30-day preset: no new Ivora call and no money figure.
 */
export async function loadTrend(
  d: ReportsDeps,
  staff: Staff,
): Promise<{ zone: string; result: StatsResult }> {
  const profile = await d.company.load(staff.operatorId).catch(() => null);
  const { zone } = reportTimeZone(profile?.timeZone ?? null, []);
  const { query } = parseReportQuery({ get: () => null }, zone, d.now());
  return { zone, result: await loadStats(d.ivora, query) };
}
