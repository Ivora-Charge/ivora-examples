import "server-only";
import type { CommandDeps } from "@/lib/commands/manage";
import { sessionOwner } from "@/lib/sessions/owner";
import { onSessionEvent } from "@/lib/sessions/events";
import { paymentDeps, type PaymentDeps } from "./registry";
import { maybeIncrement, settleCdr } from "./settle";

/**
 * Connects payments to the Sessions module's events, in this server process:
 *
 * - `cdr.received`: settle the payment of the CDR's start (capture, release, or review).
 * - `session.updated`: with incremental authorization on, raise the hold of a long
 *   session before its cost reaches the hold.
 *
 * Events are not queued, so the cron route also sweeps held payments (sweepPayments).
 * Called by the routes that receive or pull sessions and CDRs; installing twice does
 * nothing.
 */
const holder = globalThis as unknown as { __emspPaymentsListening?: boolean };

export function commandDepsOf(deps: PaymentDeps): CommandDeps {
  return {
    commands: deps.commands,
    peers: deps.peers,
    tokens: deps.tokens,
    locations: deps.locations,
    sessionOwner: sessionOwner(deps.sessions),
  };
}

export function installPaymentListeners(
  deps: () => PaymentDeps = () => paymentDeps("payments"),
): () => void {
  if (holder.__emspPaymentsListening) return () => undefined;
  holder.__emspPaymentsListening = true;
  const off = onSessionEvent(async (event) => {
    if (event.type === "cdr.received") await settleCdr(event.cdr, deps());
    else if (event.type === "session.updated") {
      const d = deps();
      await maybeIncrement(event.session, d, () => commandDepsOf(d));
    }
  });
  return () => {
    off();
    holder.__emspPaymentsListening = false;
  };
}
