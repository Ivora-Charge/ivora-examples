import { preflight } from "@/lib/accounts/api";
import { codeRoute } from "@/lib/accounts/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** Sends a sign-in email with a one-time code. Rate limited. */
export function POST(request: Request) {
  return codeRoute(request);
}

export function OPTIONS(request: Request) {
  return preflight(request, "POST");
}
