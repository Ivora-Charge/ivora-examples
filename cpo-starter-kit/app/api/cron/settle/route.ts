import { getCheckout, settleOpenCheckouts } from "@/lib/server/checkout";
import { cronAuthorized } from "@/lib/server/checkout/cron-auth";
import { config, isDemo } from "@/lib/server/env";
import { getReports, refreshReportRecords } from "@/lib/server/reports";

export const dynamic = "force-dynamic";
// The loop starts no new checkout after SETTLE_BUDGET_MS (25 s), and the reports
// refresh starts no new read after SWEEP_SECONDS (30 s) from the request's start, so
// a run ends inside this even with one 20-second read in flight.
export const maxDuration = 60;

const reply = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status });

/**
 * The settlement sweep: a scheduler calls it every minute with
 * `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends exactly that). It settles
 * the driver checkouts still in progress, least recently checked first: stops paid
 * sessions before their cost reaches the card hold, finalizes and captures ended ones,
 * and releases unused holds. Safe to run twice at once (every write has its key).
 * Then, for Reports, it copies a few ended sessions' details and re-reads a few
 * payments for refunds and captures (reads only).
 */
export async function GET(req: Request) {
  const startedAt = Date.now();
  if (isDemo()) return reply(404, { error: "Demo mode settles nothing" });
  if (!cronAuthorized(req.headers.get("authorization"), config.cronSecret))
    return reply(401, { error: "unauthorized" });
  const checked = await settleOpenCheckouts(getCheckout(), { limit: 50 });
  let reports: { details: number; payments: number } | null = null;
  try {
    reports = await refreshReportRecords(getReports(), { startedAt });
  } catch (e) {
    // Settlement ran; reports catch up on the next run.
    console.error(
      "cpo-starter-kit: reports refresh failed:",
      e instanceof Error ? e.name : "error",
    );
  }
  return reply(200, { ok: true, checked, reports });
}
