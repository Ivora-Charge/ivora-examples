import "server-only";
import { config, isDemo } from "../env";
import { getIvora } from "../ivora";
import { createSupabaseLiveStore } from "../live/supabase";
import { getOnboarding } from "../onboarding";
import { getPricing } from "../pricing";
import { createDemoLedger } from "./demo";
import type { FleetDeps } from "./service";
import { createSupabaseLedger } from "./supabase";

export * from "./service";
export { refreshCardSessions } from "./usage";
export { IMPORT_MAX_BYTES, newRequestId } from "./input";
export { FleetError } from "./types";
export type * from "./types";

/**
 * The one place that picks what Cards talks to. In demo mode it is the demo Ivora
 * client, whose cards live in the visitor's cookie, and the demo ledger, which reads
 * the sample history, and no Live tracker: nothing reaches Ivora or Supabase.
 */
export function getFleet(): FleetDeps {
  return {
    ivora: getIvora(),
    ledger: isDemo() ? createDemoLedger() : createSupabaseLedger(),
    tracker: isDemo() ? undefined : createSupabaseLiveStore(),
    pricing: getPricing().store,
    company: getOnboarding().store,
    enabled: config.fleetModule,
  };
}
