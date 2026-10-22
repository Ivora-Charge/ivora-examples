import { createHash, timingSafeEqual } from "node:crypto";
import { expireCommands } from "@/lib/commands/manage";
import { commandStore } from "@/lib/commands/registry";
import { locationStore } from "@/lib/locations/registry";
import { installDriverAppListeners } from "@/lib/driver-app/listen";
import { paymentDeps } from "@/lib/payments/registry";
import { sweepPayments } from "@/lib/payments/settle";
import { syncAllPeers } from "@/lib/locations/sync";
import { peerStore } from "@/lib/ocpi/registry";
import { pullAllSessions } from "@/lib/sessions/pull";
import { sessionStore } from "@/lib/sessions/registry";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { expireTokens } from "@/lib/tokens/manage";
import { retryPendingPushes } from "@/lib/tokens/push";
import { tokenStore } from "@/lib/tokens/registry";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Pulled CDRs settle their payments too; timed-out commands tell the driver.
installDriverAppListeners();

const NO_STORE = { "Cache-Control": "no-store" };

function authorised(header: string | null): boolean {
  const secret = config.cronSecret;
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!secret || !m) return false;
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(m[1]), digest(secret));
}

/**
 * The scheduled OCPI jobs, for a cron job (for example Vercel Cron, which sends
 * `Authorization: Bearer $CRON_SECRET`):
 *
 * 1. Tokens: marks tokens past their expiry as expired and pushes that, then retries
 *    the token pushes peers missed (at most 100 of each per call).
 * 2. Commands: ends the commands past their deadline (at most 100 per call), so a
 *    driver's start that never got an answer times out and releases its payment hold
 *    even when the app stops asking. The app's own reads end them too.
 * 3. The pull of every registered peer's tariffs and locations, then of its sessions and
 *    CDRs (changes since the last pull). Each call pulls at most 20 pages per peer and
 *    module; a larger pull resumes on the next call.
 * 4. Payments: settles held payments whose start has a CDR, releases holds queued for
 *    release (an uncertain start with no session), and marks expired holds (at most
 *    100 per call). Session events do this as CDRs arrive; this catches what they
 *    missed.
 *
 * A failure of one job does not stop the others.
 */
export async function GET(request: Request) {
  if (!config.cronSecret)
    return Response.json(
      { error: "Disabled: set CRON_SECRET (at least 32 characters)" },
      { status: 503, headers: NO_STORE },
    );
  if (!authorised(request.headers.get("Authorization")))
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: NO_STORE },
    );
  if (isDemo())
    return Response.json(
      { mode: "demo", results: [], message: "Demo mode: nothing pulled" },
      { headers: NO_STORE },
    );
  const failed = (job: string, e: unknown) =>
    console.error(
      `Scheduled ${job} failed: ${e instanceof Error ? e.name : "unknown error"}`,
    );
  let ok = true;
  let tokens: { expired: number; pushes: unknown } | undefined;
  try {
    const deps = { tokens: tokenStore(), peers: peerStore(), actor: "cron" };
    const expired = await expireTokens(deps);
    tokens = { expired, pushes: await retryPendingPushes(deps) };
  } catch (e) {
    ok = false;
    failed("token jobs", e);
  }
  let commands: number | undefined;
  try {
    commands = await expireCommands({
      commands: commandStore(),
      peers: peerStore(),
      tokens: tokenStore(),
      locations: locationStore(),
      actor: "cron",
    });
  } catch (e) {
    ok = false;
    failed("command timeouts", e);
  }
  let results: unknown;
  try {
    results = await syncAllPeers(
      { peers: peerStore(), locations: locationStore() },
      { maxPages: 20 },
    );
  } catch (e) {
    ok = false;
    failed("OCPI pull", e);
  }
  let sessions: unknown;
  try {
    sessions = await pullAllSessions(
      {
        sessions: sessionStore(),
        commands: commandStore(),
        tokens: tokenStore(),
        peers: peerStore(),
        syncState: locationStore(),
        actor: "cron",
      },
      { maxPages: 20 },
    );
  } catch (e) {
    ok = false;
    failed("sessions and CDRs pull", e);
  }
  let payments: unknown;
  try {
    payments = await sweepPayments(paymentDeps("cron"));
  } catch (e) {
    ok = false;
    failed("payment sweep", e);
  }
  return Response.json(
    ok
      ? {
          mode: "live",
          results,
          sessions,
          tokens,
          commands: { ended: commands },
          payments,
        }
      : {
          error: "Something went wrong",
          results,
          sessions,
          tokens,
          commands: { ended: commands },
          payments,
        },
    { status: ok ? 200 : 500, headers: NO_STORE },
  );
}
