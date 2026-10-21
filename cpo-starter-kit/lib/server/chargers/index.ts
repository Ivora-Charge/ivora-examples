import "server-only";
import { isDemo } from "../env";
import { getIvora } from "../ivora";
import { createDemoChargerStore } from "./demo";
import { cookieDemoChargers } from "./demo-cookie";
import type { ChargerDeps } from "./service";
import { createSupabaseChargerStore } from "./supabase";

export * from "./service";
export { ChargerError } from "./types";
export type * from "./types";

/**
 * The one place that picks the charger store. In demo mode it is the visitor's cookie
 * and the demo Ivora client (whose stations also live in the visitor's cookie), so no
 * charger command, password or other request reaches Ivora or Supabase.
 */
export function getChargers(): ChargerDeps {
  return {
    store: isDemo()
      ? createDemoChargerStore(cookieDemoChargers())
      : createSupabaseChargerStore(),
    ivora: getIvora(),
  };
}
