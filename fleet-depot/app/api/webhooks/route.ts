import { after } from "next/server";
import { config } from "@/lib/config";
import { getDepot, withLock } from "@/lib/depot";
import { handleSafely } from "@/lib/events";
import { parseEvent, verifyIvoraSignature } from "@/lib/webhook";

export const dynamic = "force-dynamic";

/**
 * Ivora webhook endpoint. Verifies Ivora-Signature over the raw body before
 * parsing, checks the tenant, deduplicates by event ID, acknowledges at once and
 * does the work after the response (Ivora allows 15 seconds per attempt).
 */
export async function POST(req: Request) {
  const d = await getDepot();
  if (d.demo)
    return Response.json(
      { error: "Demo mode does not accept webhooks" },
      { status: 404 },
    );
  const raw = await req.text();
  const v = verifyIvoraSignature(
    raw,
    req.headers.get("ivora-signature"),
    config.webhookSecret,
  );
  if (!v.ok)
    return Response.json(
      { error: `invalid signature (${v.reason})` },
      { status: 401 },
    );
  const evt = parseEvent(raw);
  if (!evt) return Response.json({ error: "malformed event" }, { status: 400 });
  if (String(evt.tenant_id) !== config.tenantId)
    return Response.json({ error: "wrong tenant" }, { status: 400 });

  const fresh = await d.store.claim("webhookEvents", evt.id, {
    id: evt.id,
    at: new Date().toISOString(),
  });
  if (!fresh) return Response.json({ ok: true, duplicate: true });

  after(() => withLock(() => handleSafely(d, evt)));
  return Response.json({ ok: true });
}
