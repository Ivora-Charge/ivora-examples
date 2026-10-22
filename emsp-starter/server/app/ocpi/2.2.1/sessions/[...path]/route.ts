import { withOcpi, type OcpiRouteOptions } from "@/lib/ocpi/server";
import { sessionsReceiver } from "@/lib/sessions/receiver";

export const dynamic = "force-dynamic";

// Our Sessions Receiver interface: a registered CPO pushes our drivers' sessions to
// /ocpi/2.2.1/sessions/{country_code}/{party_id}/{session_id}, with routing headers.
const options: OcpiRouteOptions = { access: "registered", routing: "required" };
const handler = withOcpi((ctx) => sessionsReceiver(ctx), options);

export const GET = handler;
export const PUT = handler;
export const PATCH = handler;
