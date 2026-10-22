import { preflight } from "@/lib/accounts/api";
import { installDriverAppListeners } from "@/lib/driver-app/listen";
import { chargeRoute } from "@/lib/payments/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

// Commands tell the driver when they fail; demo mode plays the mock CPO's side.
installDriverAppListeners();

/** One of the driver's charges (a start or a stop) and its payment: poll it. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return chargeRoute(request, (await params).id);
}

export function OPTIONS(request: Request) {
  return preflight(request, "GET");
}
