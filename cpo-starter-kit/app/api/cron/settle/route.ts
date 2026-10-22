import { getCheckout, settleOpenCheckouts } from "@/lib/server/checkout";
import { cronAuthorized } from "@/lib/server/checkout/cron-auth";
import { config, isDemo } from "@/lib/server/env";
import { getReports, refreshReportRecords } from "@/lib/server/reports";

export const dynamic = "force-dynamic";

const reply = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status });

/**
 * The settlement sweep: a scheduler calls it every minute with
 * `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends exactly that). It settles
 * the driver checkouts still in progress, least recently checked first: stops paid
 * sessions before their cost reaches the card hold, finalizes and captures ended ones,
 * and releases unused holds. Safe to run twice at once (every write has its key).
 * Then, for Reports, it copies a few ended sessions' details and re-reads a few
 * charged payments for refunds (reads only).
 */
export async function GET(req: Request) {
  if (isDemo()) return reply(404, { error: "Demo mode settles nothing" });
  if (!cronAuthorized(req.headers.get("authorization"), config.cronSecret))
    return reply(401, { error: "unauthorized" });
  const checked = await settleOpenCheckouts(getCheckout(), { limit: 50 });
  let reports: { details: number; refunds: number } | null = null;
  try {
    reports = await refreshReportRecords(getReports());
  } catch (e) {
    // Settlement ran; reports catch up on the next run.
    console.error(
      "cpo-starter-kit: reports refresh failed:",
      e instanceof Error ? e.name : "error",
    );
  }
  return reply(200, { ok: true, checked, reports });
}
