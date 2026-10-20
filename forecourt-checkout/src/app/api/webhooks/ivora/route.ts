import { after, NextResponse } from "next/server";
import { z } from "zod";
import { ivoraClient, liveDeps, settings } from "@/lib/server/services";
import { APPLICATION_PREFIX, reconcile } from "@/lib/server/sessions";
import {
  RecentIds,
  sessionIdFromEvent,
  verifyIvoraSignature,
} from "@/lib/webhook";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const eventSchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  tenant_id: z.number(),
  resource_id: z.string().nullable().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

// Deliveries are at least once. This drops redeliveries seen by this instance;
// reconcile() is idempotent, so a redelivery that reaches another instance is harmless.
const seen = new RecentIds();

export async function POST(request: Request) {
  const s = settings();
  const secret = process.env.IVORA_WEBHOOK_SECRET ?? "";
  if (s.demo || !secret)
    return NextResponse.json(
      { error: "webhook_not_configured" },
      { status: 503 },
    );
  const body = await request.text();
  const verdict = verifyIvoraSignature(
    secret,
    request.headers.get("ivora-signature"),
    body,
  );
  if (verdict !== "ok")
    return NextResponse.json(
      { error: verdict === "stale" ? "stale_signature" : "invalid_signature" },
      { status: verdict === "stale" ? 400 : 401 },
    );
  let event: z.infer<typeof eventSchema>;
  try {
    event = eventSchema.parse(JSON.parse(body));
  } catch {
    return NextResponse.json({ error: "malformed_event" }, { status: 400 });
  }
  if (String(event.tenant_id) !== process.env.IVORA_TENANT_ID)
    return NextResponse.json({ error: "unknown_tenant" }, { status: 400 });
  if (!seen.add(request.headers.get("ivora-event-id") ?? event.id))
    return NextResponse.json({ received: true, duplicate: true });
  const ivoraSession = sessionIdFromEvent(event);
  if (!ivoraSession) return NextResponse.json({ received: true });
  // Acknowledge now; read the current state from the API afterwards.
  after(async () => {
    try {
      const session = await ivoraClient(s).getSession(ivoraSession);
      if (session.application_reference.startsWith(APPLICATION_PREFIX))
        await reconcile(
          session.application_reference.slice(APPLICATION_PREFIX.length),
          liveDeps(s),
        );
    } catch (error) {
      console.warn(
        "[forecourt] webhook reconcile failed",
        error instanceof Error ? error.name : "unknown",
      );
    }
  });
  return NextResponse.json({ received: true }, { status: 202 });
}
