import { commandResultReceiver } from "@/lib/commands/receiver";
import { installDriverAppListeners } from "@/lib/driver-app/listen";
import { withOcpi } from "@/lib/ocpi/server";

export const dynamic = "force-dynamic";

// A failed command tells the driver; demo charging follows its commands.
installDriverAppListeners();

// Our Commands Sender interface: a registered CPO POSTs the CommandResult of a command
// we sent to /ocpi/2.2.1/commands/{command}/{uid}, our response_url, with routing
// headers.
export const POST = withOcpi((ctx) => commandResultReceiver(ctx), {
  access: "registered",
  routing: "required",
});
