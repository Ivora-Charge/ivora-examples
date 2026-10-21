import "server-only";
import { isDemo } from "../env";
import { getIvora } from "../ivora";
import { createDemoOnboardingStore } from "./demo";
import { cookieDemoOnboarding } from "./demo-cookie";
import type { OnboardingDeps } from "./service";
import { createSupabaseOnboardingStore } from "./supabase";

export * from "./service";
export { setupChecklist, type ChecklistItem } from "./checklist";
export { OnboardingError } from "./types";
export type { CompanyProfile } from "./types";
export type { StripeView, StripeState } from "./stripe";

/**
 * The one place that picks the onboarding store. In demo mode it is the visitor's
 * cookie and the demo Ivora client, so nothing reaches Supabase, Ivora or Stripe.
 */
export function getOnboarding(): OnboardingDeps {
  return {
    store: isDemo()
      ? createDemoOnboardingStore(cookieDemoOnboarding())
      : createSupabaseOnboardingStore(),
    ivora: getIvora(),
  };
}
