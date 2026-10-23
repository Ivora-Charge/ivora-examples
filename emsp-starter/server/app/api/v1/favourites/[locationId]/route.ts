import { preflight } from "@/lib/accounts/api";
import {
  putFavouriteRoute,
  deleteFavouriteRoute,
} from "@/lib/driver-app/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** Adds a location to the driver's favourites. */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ locationId: string }> },
) {
  return putFavouriteRoute(request, (await params).locationId);
}

/** Removes a location from the driver's favourites. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ locationId: string }> },
) {
  return deleteFavouriteRoute(request, (await params).locationId);
}

export function OPTIONS(request: Request) {
  return preflight(request, "PUT, DELETE");
}
