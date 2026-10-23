import { preflight } from "@/lib/accounts/api";
import { verifyRoute } from "@/lib/accounts/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** Signs in with the email's code or link; makes the account the first time. */
export function POST(request: Request) {
  return verifyRoute(request);
}

export function OPTIONS(request: Request) {
  return preflight(request, "POST");
}
