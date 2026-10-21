import { detailResponse, preflight } from "@/lib/locations/api";

export const dynamic = "force-dynamic";

/** One location with its EVSEs, connectors and display prices. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return detailResponse((await params).id);
}

export function OPTIONS() {
  return preflight();
}
