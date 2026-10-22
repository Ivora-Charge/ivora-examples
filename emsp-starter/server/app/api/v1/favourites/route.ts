import { preflight } from "@/lib/accounts/api";
import { favouritesRoute } from "@/lib/driver-app/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** The driver's favourite locations. */
export function GET(request: Request) {
  return favouritesRoute(request);
}

export function OPTIONS(request: Request) {
  return preflight(request, "GET");
}
