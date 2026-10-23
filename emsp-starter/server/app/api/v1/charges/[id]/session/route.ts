import { preflight } from "@/lib/accounts/api";
import { sessionRoute } from "@/lib/driver-app/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** A charge's session as it runs: energy, time, cost so far and live data. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return sessionRoute(request, (await params).id);
}

export function OPTIONS(request: Request) {
  return preflight(request, "GET");
}
