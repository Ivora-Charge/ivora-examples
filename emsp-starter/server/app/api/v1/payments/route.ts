import { preflight } from "@/lib/accounts/api";
import { paymentsRoute } from "@/lib/payments/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** The driver's payments, newest first. */
export function GET(request: Request) {
  return paymentsRoute(request);
}

export function OPTIONS(request: Request) {
  return preflight(request, "GET");
}
