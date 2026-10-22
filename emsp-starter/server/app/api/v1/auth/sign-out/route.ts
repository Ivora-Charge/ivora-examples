import { preflight } from "@/lib/accounts/api";
import { signOutRoute } from "@/lib/accounts/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** Ends the session of the Bearer token. */
export function POST(request: Request) {
  return signOutRoute(request);
}

export function OPTIONS(request: Request) {
  return preflight(request, "POST");
}
