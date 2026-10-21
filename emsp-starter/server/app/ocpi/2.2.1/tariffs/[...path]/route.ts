import { tariffsReceiver } from "@/lib/locations/receiver";
import { withOcpi, type OcpiRouteOptions } from "@/lib/ocpi/server";

export const dynamic = "force-dynamic";

// Our Tariffs Receiver interface: a registered CPO pushes its tariffs here, with
// routing headers.
const options: OcpiRouteOptions = { access: "registered", routing: "required" };

export const GET = withOcpi(tariffsReceiver, options);
export const PUT = withOcpi(tariffsReceiver, options);
export const PATCH = withOcpi(tariffsReceiver, options);
export const DELETE = withOcpi(tariffsReceiver, options);
