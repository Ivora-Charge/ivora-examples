import { locationsReceiver } from "@/lib/locations/receiver";
import { withOcpi, type OcpiRouteOptions } from "@/lib/ocpi/server";

export const dynamic = "force-dynamic";

// Our Locations Receiver interface: a registered CPO pushes its locations, EVSEs and
// connectors here, with routing headers.
const options: OcpiRouteOptions = { access: "registered", routing: "required" };

export const GET = withOcpi(locationsReceiver, options);
export const PUT = withOcpi(locationsReceiver, options);
export const PATCH = withOcpi(locationsReceiver, options);
