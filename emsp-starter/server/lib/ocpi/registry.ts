import "server-only";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { MemoryPeerStore, type PeerStore } from "./store";
import { SupabasePeerStore } from "./store-supabase";

const holder = globalThis as unknown as {
  __emspDemoPeers?: MemoryPeerStore;
  __emspPeerStoreOverride?: PeerStore;
};

/**
 * The peer registry in use: Supabase in live mode; in demo mode, an in-memory registry
 * that lasts as long as the server process.
 */
export function peerStore(): PeerStore {
  if (holder.__emspPeerStoreOverride) return holder.__emspPeerStoreOverride;
  if (isDemo()) return (holder.__emspDemoPeers ??= new MemoryPeerStore());
  return new SupabasePeerStore(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
  );
}

/** Tests only: use `store` instead, or go back to the default with undefined. */
export function setPeerStoreForTests(store: PeerStore | undefined): void {
  holder.__emspPeerStoreOverride = store;
}
