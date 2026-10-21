import { preflight, previewResponse } from "@/lib/locations/api";

export const dynamic = "force-dynamic";

/** What a session at one connector would cost. Display only. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return previewResponse((await params).id, request);
}

export function OPTIONS() {
  return preflight();
}
