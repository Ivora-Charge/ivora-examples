import { installPaymentListeners } from "@/lib/payments/listen";
import { withOcpi } from "@/lib/ocpi/server";
import { cdrsReceiver } from "@/lib/sessions/receiver";

export const dynamic = "force-dynamic";

// A CDR settles its payment; a running session may raise its hold.
installPaymentListeners();

// Our CDRs Receiver interface: a registered CPO POSTs each CDR of our drivers here,
// with routing headers, and gets its URL back in the Location header.
export const POST = withOcpi((ctx) => cdrsReceiver(ctx), {
  access: "registered",
  routing: "required",
});
