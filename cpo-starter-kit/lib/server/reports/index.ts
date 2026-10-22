import "server-only";
import { isDemo } from "../env";
import { getIvora } from "../ivora";
import { DEMO_HISTORY_TOKENS } from "../ivora/demo-history";
import { getLive } from "../live";
import { getOnboarding } from "../onboarding";
import type { ReportsDeps } from "./service";

export * from "./service";
export * from "./types";

/**
 * The one place that picks what reports read. In demo mode that is the demo Ivora
 * client (sample history and the visitor's own sessions, all offline) and the
 * visitor's cookie, so nothing reaches Ivora or Supabase.
 */
export function getReports(): ReportsDeps {
  const demo = isDemo();
  const live = getLive().store;
  return {
    ivora: getIvora(),
    company: getOnboarding().store,
    async tokens(operatorId) {
      const [staff, free] = await Promise.all([
        live.getStaffToken(operatorId),
        live.getFreeToken(operatorId),
      ]);
      return {
        staff: [
          ...(staff ? [staff.idToken] : []),
          ...(demo ? [DEMO_HISTORY_TOKENS.staff] : []),
        ],
        free: [
          ...(free ? [free.idToken] : []),
          ...(demo ? [DEMO_HISTORY_TOKENS.free] : []),
        ],
      };
    },
    now: Date.now,
  };
}
