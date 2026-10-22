import "server-only";
import type { DemoTariffLookup } from "../ivora/demo";
import { demoPricingSeed, type DemoPricingState } from "./demo";
import { cookieDemoPricing } from "./demo-cookie";
import { definitionInput } from "./tariff";

/**
 * Demo mode: a tariff's definition by its (demo) Ivora ID, from the visitor's pricing
 * cookie, so the demo Ivora client can quote and estimate bills offline. Outside a
 * request (tests) the sample tariffs answer.
 */
export const demoTariffLookup: DemoTariffLookup = async (tariffId) => {
  let state: DemoPricingState;
  try {
    state = await cookieDemoPricing().load();
  } catch {
    state = demoPricingSeed();
  }
  for (const t of state.tariffs)
    for (const v of t.versions)
      if (v.ivoraTariffId === tariffId && v.definition)
        return definitionInput(v.definition);
  return null;
};
