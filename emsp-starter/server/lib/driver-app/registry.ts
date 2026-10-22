import "server-only";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { MemoryDriverAppStore, type DriverAppStore } from "./store";
import { SupabaseDriverAppStore } from "./store-supabase";

const holder = globalThis as unknown as {
  __emspDemoDriverApp?: MemoryDriverAppStore;
  __emspDriverAppOverride?: DriverAppStore;
};

/** The driver app's data: Supabase in live mode; in demo mode, in memory. */
export function driverAppStore(): DriverAppStore {
  if (holder.__emspDriverAppOverride) return holder.__emspDriverAppOverride;
  if (isDemo())
    return (holder.__emspDemoDriverApp ??= new MemoryDriverAppStore());
  return new SupabaseDriverAppStore(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
  );
}

/** Tests only: use `store` instead, or go back to the default with undefined. */
export function setDriverAppStoreForTests(store: DriverAppStore | undefined) {
  holder.__emspDriverAppOverride = store;
}
