import "server-only";
import { isDemo } from "../env";
import { hostStore } from "../hosts";
import { getIvora } from "../ivora";
import { getOnboarding } from "../onboarding";
import { getReports } from "../reports";
import { createDemoNetworkStore } from "./demo";
import { cookieDemoNetwork } from "./demo-cookie";
import type { NetworkDeps } from "./service";
import { createSupabaseNetworkStore } from "./supabase";
import type { NetworkStore } from "./types";

export * from "./service";
export { NetworkError } from "./types";
export type * from "./types";

/**
 * The one place that picks the network store. In demo mode it is the visitor's cookie,
 * the sample hosts and the sample history, so nothing reaches Stripe or Supabase.
 */
export function networkStore(): NetworkStore {
  if (!isDemo()) return createSupabaseNetworkStore();
  const ivora = getIvora();
  return createDemoNetworkStore({
    cookie: cookieDemoNetwork(),
    hosts: hostStore(),
    reports: getReports().store,
    stations: async () =>
      (await ivora.listAllStations()).data.map((s) => ({
        id: s.id,
        locationId: typeof s.location_id === "number" ? s.location_id : null,
      })),
  });
}

/** What the Hosts page, statements and Reports use. */
export function getNetwork(): NetworkDeps {
  return {
    store: networkStore(),
    hosts: hostStore(),
    ivora: getIvora(),
    company: getOnboarding().store,
  };
}
