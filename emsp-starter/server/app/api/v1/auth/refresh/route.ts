import { preflight } from "@/lib/accounts/api";
import { refreshRoute } from "@/lib/accounts/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** A new session for a refresh token. */
export function POST(request: Request) {
  return refreshRoute(request);
}

export function OPTIONS(request: Request) {
  return preflight(request, "POST");
}
