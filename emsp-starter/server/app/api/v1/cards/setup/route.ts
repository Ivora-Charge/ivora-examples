import { preflight } from "@/lib/accounts/api";
import { setupRoute } from "@/lib/payments/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** What the app's PaymentSheet needs to save a card. */
export function POST(request: Request) {
  return setupRoute(request);
}

export function OPTIONS(request: Request) {
  return preflight(request, "POST");
}
