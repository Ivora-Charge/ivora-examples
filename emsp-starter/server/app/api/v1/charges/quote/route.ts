import { preflight } from "@/lib/accounts/api";
import { quoteRoute } from "@/lib/driver-app/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** The payment hold a start here would place, before the driver confirms. */
export function GET(request: Request) {
  return quoteRoute(request);
}

export function OPTIONS(request: Request) {
  return preflight(request, "GET");
}
