import { preflight } from "@/lib/accounts/api";
import { startRoute } from "@/lib/payments/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** Starts charging: a card hold, then START_SESSION to the charger's CPO. */
export function POST(request: Request) {
  return startRoute(request);
}

export function OPTIONS(request: Request) {
  return preflight(request, "POST");
}
