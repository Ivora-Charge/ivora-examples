import "server-only";
import { installPaymentListeners } from "@/lib/payments/listen";
import { installPushListeners } from "@/lib/push/notify";
import { installDemoCharging } from "./demo-charging";

/**
 * Subscribes what acts on the server's events, in this process: payments (capture on
 * a CDR, raises), push notifications to the driver, and demo mode's charging. Call it
 * at the top of every route whose requests emit session, command or payment events;
 * installing twice does nothing.
 */
export function installDriverAppListeners() {
  installPaymentListeners();
  installPushListeners();
  installDemoCharging();
}
