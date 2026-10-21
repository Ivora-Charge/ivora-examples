import { ourVersionDetails } from "@/lib/ocpi/identity";
import { ocpiResponse, withOcpi } from "@/lib/ocpi/server";

export const dynamic = "force-dynamic";

/** OCPI 2.2.1 version details: the modules this eMSP implements. */
export const GET = withOcpi(
  async (ctx) => ocpiResponse(ourVersionDetails(), ctx),
  { access: "handshake", routing: "none" },
);
