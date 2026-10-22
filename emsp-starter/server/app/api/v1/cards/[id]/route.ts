import { preflight } from "@/lib/accounts/api";
import { removeCardRoute } from "@/lib/payments/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** Removes one of the driver's saved cards. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return removeCardRoute(request, (await params).id);
}

export function OPTIONS(request: Request) {
  return preflight(request, "DELETE");
}
