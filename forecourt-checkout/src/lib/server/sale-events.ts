import "server-only";
import { RecentIds } from "../webhook";

// The seam for point-of-sale integrations. When an in-store sale has a final
// bill with money still to collect, the app emits `sale.due`. Nothing listens
// yet; a POS integration subscribes with saleEvents.on() and forwards the event
// (for example as a signed webhook). The event ID is stable per sale, so a
// listener can de-duplicate: a sale can be seen as due more than once (every
// poll, webhook and sweep re-reads it), and each server instance emits it once.

export type SaleDueEvent = {
  /** Stable per sale: `<sale ID>:due`. */
  id: string;
  type: "sale.due";
  sale: string;
  charger: { code: string; connector: number; label: string };
  mode: "prepay" | "postpay";
  amountDueCents: number;
  currency: string;
  energyWh: number;
  startedAt: string | null;
  endedAt: string | null;
};

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
