import { installDriverAppListeners } from "@/lib/driver-app/listen";
import { withOcpi, type OcpiRouteOptions } from "@/lib/ocpi/server";
import { sessionsReceiver } from "@/lib/sessions/receiver";

export const dynamic = "force-dynamic";

// A CDR settles its payment; a running session may raise its hold; a completed one
// tells the driver.
installDriverAppListeners();

// Our Sessions Receiver interface: a registered CPO pushes our drivers' sessions to
// /ocpi/2.2.1/sessions/{country_code}/{party_id}/{session_id}, with routing headers.
const options: OcpiRouteOptions = { access: "registered", routing: "required" };
const handler = withOcpi((ctx) => sessionsReceiver(ctx), options);

export const GET = handler;
export const PUT = handler;
export const PATCH = handler;
