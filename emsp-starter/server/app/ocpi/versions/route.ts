import { ourVersions } from "@/lib/ocpi/identity";
import { ocpiResponse, withOcpi } from "@/lib/ocpi/server";

// Peers and tokens come from the database at request time.
export const dynamic = "force-dynamic";

/** OCPI versions endpoint. Needs a token we issued, including a Token A. */
export const GET = withOcpi(async (ctx) => ocpiResponse(ourVersions(), ctx), {
  access: "handshake",
  routing: "none",
});
