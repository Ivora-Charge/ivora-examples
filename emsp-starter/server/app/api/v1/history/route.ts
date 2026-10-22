import { preflight } from "@/lib/accounts/api";
import { historyRoute } from "@/lib/driver-app/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** The driver's charges with a payment, newest first. */
export function GET(request: Request) {
  return historyRoute(request);
}

export function OPTIONS(request: Request) {
  return preflight(request, "GET");
}
