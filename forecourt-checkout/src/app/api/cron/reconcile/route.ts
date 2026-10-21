import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  ivoraClient,
  liveDeps,
  liveStoreDeps,
  settings,
} from "@/lib/server/services";
import { APPLICATION_PREFIX, reconcile } from "@/lib/server/sessions";
import { reconcileStoreSession } from "@/lib/server/store";
import { STORE_PREFIX } from "@/lib/store";

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
 * missed webhooks. Settles finished sessions and releases unused holds; for
 * in-store sales it stops at the prepaid limit, finalizes and records the
 * prepaid capture. It never marks an in-store sale paid.
 */
export async function GET(request: Request) {
  if (!authorized(request))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const s = settings();
  if (s.demo) return NextResponse.json({ demo: true, reconciled: 0 });
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const sessions = await ivoraClient(s).listAllSessions();
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
      if (x.application_reference.startsWith(STORE_PREFIX))
        await reconcileStoreSession(x, liveStoreDeps(s));
      else
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
