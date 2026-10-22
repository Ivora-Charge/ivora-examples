import { preflight } from "@/lib/accounts/api";
import { meRoute } from "@/lib/accounts/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** The signed-in driver's account. */
export function GET(request: Request) {
  return meRoute(request);
}

export function OPTIONS(request: Request) {
  return preflight(request, "GET");
}
