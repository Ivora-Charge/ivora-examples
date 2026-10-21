import { withOcpi } from "@/lib/ocpi/server";
import { authorizeToken } from "@/lib/tokens/authorize";

export const dynamic = "force-dynamic";

// Real-time authorization: POST /ocpi/2.2.1/tokens/{token_uid}/authorize, from a
// registered CPO, with routing headers.
export const POST = withOcpi(authorizeToken, {
  access: "registered",
  routing: "required",
});
