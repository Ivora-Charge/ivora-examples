import {
  deleteCredentials,
  getCredentials,
  postCredentials,
  putCredentials,
} from "@/lib/ocpi/handshake";
import { withOcpi, type OcpiRouteOptions } from "@/lib/ocpi/server";

export const dynamic = "force-dynamic";

// The credentials module takes no routing headers. Each handler checks the peer's
// registration state itself: POST needs a Token A, PUT and DELETE a registered peer.
const options: OcpiRouteOptions = { access: "handshake", routing: "none" };

export const GET = withOcpi(getCredentials, options);
export const POST = withOcpi(postCredentials, options);
export const PUT = withOcpi(putCredentials, options);
export const DELETE = withOcpi(deleteCredentials, options);
