import { preflight } from "@/lib/accounts/api";
import { emailReceiptRoute } from "@/lib/driver-app/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** Emails a charge's receipt to the driver again. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return emailReceiptRoute(request, (await params).id);
}

export function OPTIONS(request: Request) {
  return preflight(request, "POST");
}
