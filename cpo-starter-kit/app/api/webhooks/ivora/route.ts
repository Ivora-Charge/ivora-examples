import { after } from "next/server";
import { config, isDemo } from "@/lib/server/env";
import { eventStation, getLive, handleEvent } from "@/lib/server/live";
import {
  MAX_BODY_BYTES,
  parseEvent,
  verifyIvoraSignature,
} from "@/lib/server/live/webhook";

export const dynamic = "force-dynamic";

const reply = (status: number, error?: string) =>
  Response.json(error ? { error } : { ok: true }, { status });

/**
 * Ivora webhook endpoint (register it with `npm run ivora:webhook -- register`).
 * Verifies Ivora-Signature over the raw body before parsing, checks the tenant,
 * deduplicates by event ID, acknowledges at once and does the work after the response
 * (Ivora allows 15 seconds per attempt). The event is only a cue: the work re-reads
 * state from the API, and open Live pages re-read it too.
 */
export async function POST(req: Request) {
  if (isDemo()) return reply(404, "Demo mode does not accept webhooks");
  if (!config.webhookSecret)
    return reply(503, "IVORA_WEBHOOK_SECRET is not set");
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES)
    return reply(413, "too large");
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return reply(413, "too large");
  const v = verifyIvoraSignature(
    raw,
    req.headers.get("ivora-signature"),
    config.webhookSecret,
  );
  if (!v.ok) return reply(401, `invalid signature (${v.reason})`);
  const evt = parseEvent(raw);
  if (!evt) return reply(400, "malformed event");
  if (String(evt.tenant_id) !== config.tenantId)
    return reply(400, "wrong tenant");

  const d = getLive();
  let fresh: boolean;
  try {
    fresh = await d.store.recordEvent({
      id: evt.id,
      type: evt.type,
      stationId: eventStation(evt),
    });
  } catch (e) {
    // Not stored, so not acknowledged: Ivora delivers it again later.
    console.error("cpo-starter-kit: webhook store failed:", {
      error: e instanceof Error ? e.name : "error",
    });
    return reply(500, "not stored");
  }
  if (!fresh) return Response.json({ ok: true, duplicate: true });

  after(async () => {
    try {
      await handleEvent(d, evt);
    } catch (e) {
      // The next page load or check re-reads the API anyway.
      console.error("cpo-starter-kit: webhook processing failed:", {
        type: evt.type,
        error: e instanceof Error ? e.name : "error",
      });
    }
  });
  return reply(200);
}
