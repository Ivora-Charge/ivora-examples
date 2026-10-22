import { withOcpi } from "@/lib/ocpi/server";
import { cdrsReceiver } from "@/lib/sessions/receiver";

export const dynamic = "force-dynamic";

// A CDR we received, at the URL we answered its POST with: GET /ocpi/2.2.1/cdrs/{id}.
export const GET = withOcpi((ctx) => cdrsReceiver(ctx), {
  access: "registered",
  routing: "required",
});
