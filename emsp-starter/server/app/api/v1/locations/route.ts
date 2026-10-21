import { preflight, searchResponse } from "@/lib/locations/api";

// Locations change all the time: read at request time.
export const dynamic = "force-dynamic";

/** Search: near a point, by text, EVSE ID or charger ID, with filters. See the README. */
export function GET(request: Request) {
  return searchResponse(request);
}

export function OPTIONS() {
  return preflight();
}
