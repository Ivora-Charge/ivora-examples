import "server-only";
import { isDemo } from "../env";
import { getIvora } from "../ivora";
import { getOnboarding } from "../onboarding";
import { createDemoPricingStore } from "./demo";
import { cookieDemoPricing } from "./demo-cookie";
import type { PricingDeps } from "./service";
import { createSupabasePricingStore } from "./supabase";

export * from "./service";
export { PricingError } from "./types";
export type * from "./types";

/**
 * The one place that picks the pricing store. In demo mode it is the visitor's cookie
 * and the demo Ivora client, whose simulation runs offline: no tariff, preview or
 * other request reaches Ivora or Supabase.
 */
export function getPricing(): PricingDeps {
  return {
    store: isDemo()
      ? createDemoPricingStore(cookieDemoPricing())
      : createSupabasePricingStore(),
    ivora: getIvora(),
    company: getOnboarding().store,
  };
}
