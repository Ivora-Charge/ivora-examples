import "server-only";
import { cookieDemoCheckout } from "../checkout/demo-cookie";
import { isDemo } from "../env";
import { getIvora } from "../ivora";
import { getOnboarding } from "../onboarding";
import { createDemoReportsStore } from "./demo";
import type { ReportsDeps } from "./service";
import { createSupabaseReportsStore } from "./supabase";

export * from "./service";
export * from "./types";

/**
 * The one place that picks what reports read. In demo mode that is the demo Ivora
 * client and sample history plus the visitor's own demo checkouts (their cookie), so
 * nothing reaches Ivora or Supabase.
 */
export function getReports(): ReportsDeps {
  const ivora = getIvora();
  const now = Date.now;
  return {
    ivora,
    company: getOnboarding().store,
    store: isDemo()
      ? createDemoReportsStore({
          ivora,
          own: async () => (await cookieDemoCheckout().load()).records,
          now,
        })
      : createSupabaseReportsStore(now),
    now,
  };
}
