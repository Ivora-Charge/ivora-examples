import { preflight } from "@/lib/accounts/api";
import { defaultCardRoute } from "@/lib/payments/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** Chooses the card the driver's charging is paid with. */
export function PUT(request: Request) {
  return defaultCardRoute(request);
}

export function OPTIONS(request: Request) {
  return preflight(request, "PUT");
}
