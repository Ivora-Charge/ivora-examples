import "server-only";
import type { Command } from "./store";

/**
 * Internal command events, for the parts that tell the driver (push notifications):
 *
 * - `command.finished`: a START_SESSION or STOP_SESSION reached its final status
 *   (succeeded, failed, not_supported, timed_out or hold_failed), once, from the one
 *   compare-and-swap that ended it.
 *
 * Listeners run in this server process after the change; one that throws is logged
 * and skipped, and never fails the command. Events carry the command's IDs and status,
 * never the driver's token.
 */
export type CommandEvent = {
  type: "command.finished";
  command: Pick<
    Command,
    | "id"
    | "type"
    | "driverRef"
    | "status"
    | "result"
    | "requestId"
    | "createdAt"
    | "finishedAt"
  >;
};

export type CommandEventListener = (
  event: CommandEvent,
) => Promise<void> | void;

const holder = globalThis as unknown as {
  __emspCommandListeners?: Set<CommandEventListener>;
};
const listeners = () => (holder.__emspCommandListeners ??= new Set());

/** Calls `listener` for every command event from now on. Returns the unsubscribe. */
export function onCommandEvent(listener: CommandEventListener): () => void {
  listeners().add(listener);
  return () => listeners().delete(listener);
}

/** Calls every listener with `event`, in order. Never throws. */
export async function emitCommandEvent(event: CommandEvent): Promise<void> {
  for (const listener of [...listeners()])
    try {
      await listener(structuredClone(event));
    } catch (e) {
      console.error(
        `A ${event.type} listener failed: ${e instanceof Error ? e.name : "unknown error"}`,
      );
    }
}
