import { config, isDemo } from "./config";
import { getDepot, logEvent, replan, withLock } from "./depot";

const g = globalThis as unknown as { __replanTimer?: NodeJS.Timeout };

/**
 * Replan on a timer as well as on events (live mode): retries a decrease that failed
 * or is not confirmed yet, lets raises through once it is, and follows departures
 * as they pass. Demo mode moves its own simulated clock instead.
 */
export function startReplanTimer() {
  if (isDemo() || g.__replanTimer) return;
  g.__replanTimer = setInterval(() => {
    void withLock(async () => {
      const d = await getDepot();
      await replan(d).catch((e) =>
        logEvent(d, "plan.error", e instanceof Error ? e.message : "error"),
      );
    });
  }, config.replanIntervalSeconds * 1000);
  g.__replanTimer.unref();
}
