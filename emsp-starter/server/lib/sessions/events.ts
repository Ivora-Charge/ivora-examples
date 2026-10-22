import "server-only";
import type { StoredCdr, StoredSession } from "./store";

/**
 * Internal events of the Sessions and CDRs modules, for the parts that act on them
 * (payments capture on a CDR, the app shows a running session, notifications):
 *
 * - `session.started`: the first time we hold a session, whatever its status.
 * - `session.updated`: a later change we applied (status, kWh, cost, charging periods).
 * - `session.completed`: once per session, when it is COMPLETED or INVALID, or a CDR
 *   for it arrives, whichever comes first.
 * - `cdr.received`: once per CDR, when it is first stored.
 *
 * The same change pushed twice, or pulled after a push, emits nothing the second time.
 * Each event is emitted by the one write that made it true (an insert, or a
 * compare-and-swap), so concurrent pushes never emit it twice.
 *
 * Listeners run in this server process, in order, after the write. A listener that
 * throws is logged and skipped: it never fails the CPO's request. Events are not
 * queued: a listener that must not miss one (a payment capture) also checks the stored
 * sessions and CDRs on a schedule.
 */
export type SessionEvent =
  | {
      type: "session.started" | "session.updated" | "session.completed";
      session: StoredSession;
    }
  | { type: "cdr.received"; cdr: StoredCdr };

export type SessionEventListener = (
  event: SessionEvent,
) => Promise<void> | void;

const holder = globalThis as unknown as {
  __emspSessionListeners?: Set<SessionEventListener>;
};
const listeners = () => (holder.__emspSessionListeners ??= new Set());

/** Calls `listener` for every event from now on. Returns the unsubscribe function. */
export function onSessionEvent(listener: SessionEventListener): () => void {
  listeners().add(listener);
  return () => listeners().delete(listener);
}

/** Calls every listener with `event`, in order. Never throws. */
export async function emitSessionEvent(event: SessionEvent): Promise<void> {
  for (const listener of [...listeners()])
    try {
      await listener(structuredClone(event));
    } catch (e) {
      console.error(
        `A ${event.type} listener failed: ${e instanceof Error ? e.name : "unknown error"}`,
      );
    }
}
