import { preflight } from "@/lib/accounts/api";
import { installDriverAppListeners } from "@/lib/driver-app/listen";
import { stopRoute } from "@/lib/payments/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

// Commands tell the driver when they fail; demo mode plays the mock CPO's side.
installDriverAppListeners();

/** Stops the session of one of the driver's starts. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return stopRoute(request, (await params).id);
}

export function OPTIONS(request: Request) {
  return preflight(request, "POST");
}
