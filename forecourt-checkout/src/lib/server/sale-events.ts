import "server-only";
import type { SaleDueEvent } from "../store";
import { RecentIds } from "../webhook";

// The in-process seam for point-of-sale integrations. When an in-store sale
// finishes with something for the counter to do (money to collect or change
// to hand back), the app emits `sale.due` (see saleDueEvent() in
// src/lib/store.ts). The signed `session_due` webhook
// (src/lib/server/pos-webhook.ts) is wired next to this in services.ts, with
// its own retries; other in-process listeners can subscribe with
// saleEvents.on(). The event ID is stable per sale, so a listener can
// de-duplicate: a sale can be seen as due more than once (every poll, webhook
// and sweep re-reads it), and each server instance emits it here once.

export type { SaleDueEvent };

type Listener = (event: SaleDueEvent) => void | Promise<void>;

export class SaleEvents {
  private readonly listeners = new Set<Listener>();
  private readonly seen = new RecentIds();

  /** Returns a function that removes the listener. */
  on(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async emit(event: SaleDueEvent) {
    if (!this.seen.add(event.id)) return;
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (error) {
        console.warn(
          "[forecourt] sale event listener failed",
          error instanceof Error ? error.name : "unknown",
        );
      }
    }
  }
}

export const saleEvents = new SaleEvents();
