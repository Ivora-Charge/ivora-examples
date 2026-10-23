import { preflight } from "@/lib/accounts/api";
import { receiptRoute } from "@/lib/driver-app/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** A charge's receipt, from its CDR and its payment. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return receiptRoute(request, (await params).id);
}

export function OPTIONS(request: Request) {
  return preflight(request, "GET");
}
