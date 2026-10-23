import { preflight } from "@/lib/accounts/api";
import { activeRoute } from "@/lib/driver-app/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** The driver's charge in progress, if any, so the app can show it again. */
export function GET(request: Request) {
  return activeRoute(request);
}

export function OPTIONS(request: Request) {
  return preflight(request, "GET");
}
