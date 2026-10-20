import { NextResponse } from "next/server";
import { db } from "@/lib/server/store";
import { applyEvent } from "@/lib/server/service";
import { verifyWebhookSignature } from "@/lib/webhook";

/**
 * Ivora charger events (station.connected, station.booted,
 * station.disconnected). Verify the signature over the raw body before
 * parsing, acknowledge each event ID once, and treat the event as a nudge:
 * the wizard still reads the current state from the API.
 */
export async function POST(req: Request) {
  const secret = process.env.IVORA_WEBHOOK_SECRET;
  if (!secret)
    return NextResponse.json(
      { error: "webhook_not_configured" },
      { status: 503 },
    );
  const raw = await req.text();
  const verdict = verifyWebhookSignature(
    secret,
    req.headers.get("ivora-signature"),
    raw,
  );
  if (verdict !== "ok")
    return NextResponse.json(
      { error: verdict === "stale" ? "stale_signature" : "invalid_signature" },
      { status: verdict === "stale" ? 400 : 401 },
    );
  let event: {
    id?: unknown;
    type?: unknown;
    tenant_id?: unknown;
    station_id?: number | string | null;
    resource_id?: string | null;
    data?: Record<string, unknown>;
  };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "malformed_event" }, { status: 400 });
  }
  const id = req.headers.get("ivora-event-id") ?? event.id;
  if (typeof id !== "string" || !id || typeof event.type !== "string")
    return NextResponse.json({ error: "malformed_event" }, { status: 400 });
  if (String(event.tenant_id) !== process.env.IVORA_TENANT_ID)
    return NextResponse.json({ error: "unknown_tenant" }, { status: 400 });
  if (!db().events.add(id))
    return NextResponse.json({ received: true, duplicate: true });
  applyEvent({ ...event, id, type: event.type, tenant_id: undefined });
  return NextResponse.json({ received: true });
}
