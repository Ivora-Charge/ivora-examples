import { createHash, timingSafeEqual } from "node:crypto";
import { expireCommands } from "@/lib/commands/manage";
import { commandStore } from "@/lib/commands/registry";
import { locationStore } from "@/lib/locations/registry";
import { syncAllPeers } from "@/lib/locations/sync";
import { peerStore } from "@/lib/ocpi/registry";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { expireTokens } from "@/lib/tokens/manage";
import { retryPendingPushes } from "@/lib/tokens/push";
import { tokenStore } from "@/lib/tokens/registry";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
 * 3. The pull of every registered peer's tariffs and locations. Each call pulls at most
 *    20 pages per peer and module; a larger pull resumes on the next call.
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
  return Response.json(
    ok
      ? { mode: "live", results, tokens, commands: { ended: commands } }
      : {
          error: "Something went wrong",
          results,
          tokens,
          commands: { ended: commands },
        },
    { status: ok ? 200 : 500, headers: NO_STORE },
  );
}
