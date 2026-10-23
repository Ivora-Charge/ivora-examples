import "server-only";
import { isDemo } from "../env";
import { getIvora } from "../ivora";
import { createDemoLiveStore } from "./demo";
import { cookieDemoLive } from "./demo-cookie";
import type { LiveDeps } from "./service";
import { createSupabaseLiveStore } from "./supabase";

export * from "./service";
export * from "./transactions";
export { LiveError } from "./types";
export type * from "./types";

/**
 * The one place that picks the command store. In demo mode it is the visitor's cookie
 * and the demo Ivora client (whose chargers also live in the visitor's cookie), so no
 * charger command or other request reaches Ivora or Supabase.
 */
export function getLive(): LiveDeps {
  return {
    store: isDemo()
      ? createDemoLiveStore(cookieDemoLive())
      : createSupabaseLiveStore(),
    ivora: getIvora(),
  };
}
