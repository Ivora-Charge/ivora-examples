import { createHash, timingSafeEqual } from "node:crypto";
import { locationStore } from "@/lib/locations/registry";
import { syncAllPeers } from "@/lib/locations/sync";
import { peerStore } from "@/lib/ocpi/registry";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";

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
 * The scheduled pull of every registered peer's tariffs and locations, for a cron job
 * (for example Vercel Cron, which sends `Authorization: Bearer $CRON_SECRET`). Each call
 * pulls at most 20 pages per peer and module; a larger pull resumes on the next call.
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
  try {
    const results = await syncAllPeers(
      { peers: peerStore(), locations: locationStore() },
      { maxPages: 20 },
    );
    return Response.json({ mode: "live", results }, { headers: NO_STORE });
  } catch (e) {
    console.error(
      `Scheduled OCPI pull failed: ${e instanceof Error ? e.name : "unknown error"}`,
    );
    return Response.json(
      { error: "Something went wrong" },
      { status: 500, headers: NO_STORE },
    );
  }
}
