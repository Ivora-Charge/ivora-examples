import "server-only";
import { isDemo } from "../env";
import { getIvora } from "../ivora";
import { cookieDemoStore } from "../team/demo-cookie";
import { createDemoHostStore } from "./demo";
import { cookieDemoHosts } from "./demo-cookie";
import type { HostDeps } from "./service";
import { createSupabaseHostStore } from "./supabase";
import type { HostStore } from "./types";

export * from "./service";
export { HostError } from "./types";
export type * from "./types";

/**
 * The one place that picks the host store. In demo mode it is the visitor's cookie
 * (the two sample hosts), so nothing reaches Supabase or any other service.
 */
export function hostStore(): HostStore {
  return isDemo()
    ? createDemoHostStore(cookieDemoHosts(), cookieDemoStore())
    : createSupabaseHostStore();
}

/** What the Hosts page and its actions use. */
export async function getHosts(): Promise<HostDeps> {
  const store = hostStore();
  if (store.mode === "demo")
    return { store, ivora: getIvora(), deleteLogin: null };
  // Imported here so demo mode never loads the Supabase Auth admin client.
  const { getTeam } = await import("../team");
  const accounts = getTeam().accounts;
  return {
    store,
    ivora: getIvora(),
    deleteLogin: accounts ? (id) => accounts.deleteUser(id) : null,
  };
}
