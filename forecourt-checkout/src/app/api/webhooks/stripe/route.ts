import { after, NextResponse } from "next/server";
import { liveDeps, settings } from "@/lib/server/services";
import { LIVE_SESSION_ID, reconcile } from "@/lib/server/sessions";
import { StripeGateway } from "@/lib/server/stripe";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.expired",
]);

/** Starts charging as soon as the card hold is authorized, even if the driver closed the page. */
export async function POST(request: Request) {
  const s = settings();
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  if (s.demo || !secret)
    return NextResponse.json(
      { error: "webhook_not_configured" },
      { status: 503 },
    );
  const body = await request.text();
  let event: ReturnType<typeof StripeGateway.verifyWebhook>;
  try {
    event = StripeGateway.verifyWebhook(
      body,
      request.headers.get("stripe-signature") ?? "",
      secret,
    );
  } catch {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }
  if (!EVENTS.has(event.type)) return NextResponse.json({ received: true });
  const id = (event.data.object as { id?: unknown }).id;
  if (typeof id !== "string" || !LIVE_SESSION_ID.test(id))
    return NextResponse.json({ received: true });
  after(async () => {
    try {
      await reconcile(id, liveDeps(s));
    } catch (error) {
      console.warn(
        "[forecourt] stripe webhook reconcile failed",
        error instanceof Error ? error.name : "unknown",
      );
    }
  });
  return NextResponse.json({ received: true });
}
