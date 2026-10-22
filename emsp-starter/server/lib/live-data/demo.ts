import "server-only";
import type { LiveDataAdapter } from "./adapter";

/**
 * Demo mode's adapter for the built-in mock CPO: an invented, rising SoC for a session
 * that is charging, computed here. It sends nothing anywhere.
 */
export function demoAdapter(now: () => number = Date.now): LiveDataAdapter {
  return {
    kind: "demo",
    async getLive(ref) {
      if (ref.status !== "ACTIVE") return {};
      const minutes = Math.max(
        0,
        (now() - Date.parse(ref.startDateTime)) / 60_000,
      );
      const at = new Date(now()).toISOString();
      return {
        socPercent: Math.min(95, Math.round(30 + minutes * 0.8)),
        socMeasuredAt: at,
        powerKw: minutes < 60 ? 48.5 : 11,
        powerMeasuredAt: at,
      };
    },
  };
}
