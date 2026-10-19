import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { ivoraClient, liveDeps, settings } from "@/lib/server/services";
import { APPLICATION_PREFIX, reconcile } from "@/lib/server/sessions";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SETTLED = new Set([
  "reported_paid",
  "reported_released",
  "reported_refunded",
]);
const WINDOW_MS = 8 * 24 * 60 * 60 * 1000;

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  const given = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  return (
    Boolean(secret) &&
    given.length === expected.length &&
    timingSafeEqual(Buffer.from(given), Buffer.from(expected))
  );
}

/**
 * Safety sweep for sessions nobody is watching: drivers who closed the page,
 * missed webhooks. Settles finished sessions and releases unused holds.
 */
export async function GET(request: Request) {
  if (!authorized(request))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const s = settings();
  if (s.demo) return NextResponse.json({ demo: true, reconciled: 0 });
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const sessions = await ivoraClient(s).listSessions(100);
  const open = sessions.filter(
    (x) =>
      x.application_reference.startsWith(APPLICATION_PREFIX) &&
      x.created_at >= since &&
      !SETTLED.has(x.settlement?.status ?? ""),
  );
  let reconciled = 0;
  const failed: string[] = [];
  for (const x of open) {
    try {
      await reconcile(
        x.application_reference.slice(APPLICATION_PREFIX.length),
        liveDeps(s),
      );
      reconciled += 1;
    } catch {
      failed.push(x.id);
    }
  }
  return NextResponse.json({ reconciled, failed });
}
