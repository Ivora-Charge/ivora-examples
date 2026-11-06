import "server-only";
import { getChargers } from "../chargers";
import { config, isDemo } from "../env";
import { getIvora } from "../ivora";
import { getLive } from "../live";
import { getPricing } from "../pricing";
import { resolveQrBase, type QrBase } from "../qr-base";
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
 * payment, capture, release or charger command reaches Ivora, Stripe or Supabase.
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
      tokens: getLive().store,
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
    tokens: getLive().store,
    limiter: createSupabaseLimiter(),
    publicOrigin: publicOrigin(),
    secret: config.supabaseServiceRoleKey,
    cache: s.cache,
  };
}

/**
 * The kit's own public origin (PUBLIC_BASE_URL, else APP_URL; the one stickers print):
 * where drivers come back after Ivora's hosted checkout, once it is a verified return
 * domain. Null when it isn't a stable https origin of your own.
 */
export function publicOrigin(): string | null {
  const r = publicBase();
  return r.ok ? r.base : null;
}

/** The same, with the reason when it isn't one. */
export function publicBase(): QrBase {
  return resolveQrBase({ demo: false, requestOrigin: "" });
}

/** Tests: forget shared reads. */
export function resetCheckoutForTests() {
  delete g.__cpoCheckout;
}
