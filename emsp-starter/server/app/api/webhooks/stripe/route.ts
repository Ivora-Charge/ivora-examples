import { stripeWebhookRoute } from "@/lib/payments/routes";

export const dynamic = "force-dynamic";

// Stripe's payment intent, charge and setup intent events, checked against
// STRIPE_WEBHOOK_SECRET. Server to server: no CORS.
export function POST(request: Request) {
  return stripeWebhookRoute(request);
}
