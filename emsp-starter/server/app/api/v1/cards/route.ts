import { preflight } from "@/lib/accounts/api";
import { cardsRoute } from "@/lib/payments/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** The driver's saved cards, as Stripe holds them. */
export function GET(request: Request) {
  return cardsRoute(request);
}

export function OPTIONS(request: Request) {
  return preflight(request, "GET");
}
