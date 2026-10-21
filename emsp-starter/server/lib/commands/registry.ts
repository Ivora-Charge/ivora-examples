import "server-only";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { MemoryCommandStore, type CommandStore } from "./store";
import { SupabaseCommandStore } from "./store-supabase";

const holder = globalThis as unknown as {
  __emspDemoCommands?: MemoryCommandStore;
  __emspCommandStoreOverride?: CommandStore;
};

/**
 * The command store in use: Supabase in live mode; in demo mode, in memory for as long
 * as the server process runs.
 */
export function commandStore(): CommandStore {
  if (holder.__emspCommandStoreOverride)
    return holder.__emspCommandStoreOverride;
  if (isDemo()) return (holder.__emspDemoCommands ??= new MemoryCommandStore());
  return new SupabaseCommandStore(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
  );
}

/** Tests only: use `store` instead, or go back to the default with undefined. */
export function setCommandStoreForTests(store: CommandStore | undefined) {
  holder.__emspCommandStoreOverride = store;
}
