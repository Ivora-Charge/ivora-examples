import { preflight } from "@/lib/accounts/api";
import {
  putPushTokenRoute,
  deletePushTokenRoute,
} from "@/lib/driver-app/routes";

// Driver data: read at request time, never cached.
export const dynamic = "force-dynamic";

/** Saves this device's push token, for notifications. */
export function PUT(request: Request) {
  return putPushTokenRoute(request);
}

/** Forgets this device's push token (sign-out, or notifications off). */
export function DELETE(request: Request) {
  return deletePushTokenRoute(request);
}

export function OPTIONS(request: Request) {
  return preflight(request, "PUT, DELETE");
}
