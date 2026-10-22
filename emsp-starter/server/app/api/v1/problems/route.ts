import { preflight } from "@/lib/accounts/api";
import { problemRoute } from "@/lib/driver-app/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** A problem the driver reports at a charger, for the admin web. */
export function POST(request: Request) {
  return problemRoute(request);
}

export function OPTIONS(request: Request) {
  return preflight(request, "POST");
}
