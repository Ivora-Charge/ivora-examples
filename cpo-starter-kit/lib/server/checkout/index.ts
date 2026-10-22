import "server-only";
import { getChargers } from "../chargers";
import { config, isDemo } from "../env";
import { getIvora } from "../ivora";
import { getPricing } from "../pricing";
import { createSupabaseLimiter } from "../team/supabase";
import { createDemoCheckoutStore, withDemoSimulation } from "./demo";
import { cookieDemoCheckout } from "./demo-cookie";
import type { CheckoutDeps } from "./service";
import { createSupabaseCheckoutStore } from "./supabase";

export * from "./service";
export { CheckoutError } from "./types";
export type * from "./types";

interface Shared {
  cache: CheckoutDeps["cache"];
}
const g = globalThis as unknown as { __cpoCheckout?: Shared };
const shared = (): Shared => (g.__cpoCheckout ??= { cache: new Map() });

/**
 * The one place that picks the checkout store. In demo mode it is the visitor's cookie
 * and the demo Ivora client (with the visitor's simulation applied), so no bill,
 * payment or charger command reaches Ivora, Stripe or Supabase.
 */
export function getCheckout(): CheckoutDeps {
  const s = shared();
  if (isDemo()) {
    const cookie = cookieDemoCheckout();
    return {
      store: createDemoCheckoutStore(cookie),
      ivora: withDemoSimulation(
        getIvora(),
        async () => (await cookie.load()).simulate,
      ),
      chargers: getChargers().store,
      pricing: getPricing().store,
      // Demo checkouts send nothing anywhere, and all visitors of a public demo share
      // one sample operator and its connectors: they are not limited.
      limiter: { take: async () => true },
      secret: "demo-mode",
      // Demo reads are the visitor's own cookie: never shared between visitors.
      cache: new Map(),
    };
  }
  return {
    store: createSupabaseCheckoutStore(),
    ivora: getIvora(),
    chargers: getChargers().store,
    pricing: getPricing().store,
    limiter: createSupabaseLimiter(),
    secret: config.supabaseServiceRoleKey,
    cache: s.cache,
  };
}

/** Tests: forget shared reads. */
export function resetCheckoutForTests() {
  delete g.__cpoCheckout;
}
