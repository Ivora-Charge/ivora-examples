import { withOcpi } from "@/lib/ocpi/server";
import { tokensSender } from "@/lib/tokens/sender";

export const dynamic = "force-dynamic";

// Our Tokens Sender interface: a registered CPO pulls our drivers' tokens, paginated,
// with routing headers.
export const GET = withOcpi(tokensSender, {
  access: "registered",
  routing: "required",
});
