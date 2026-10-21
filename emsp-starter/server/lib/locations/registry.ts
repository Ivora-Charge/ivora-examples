import "server-only";
import { sampleLocations, sampleTariffs } from "@/lib/mock-cpo/sample-data";
import { peerStore } from "@/lib/ocpi/registry";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { MemoryLocationStore, type LocationStore } from "./store";
import { SupabaseLocationStore } from "./store-supabase";

/** The peer demo mode shows: the built-in mock CPO, never contacted over the network. */
export const DEMO_PEER_ID = "demo-mock-cpo";
export const DEMO_PARTY = { countryCode: "ZZ", partyId: "MCK" } as const;

const holder = globalThis as unknown as {
  __emspDemoLocations?: MemoryLocationStore;
  __emspLocationStoreOverride?: LocationStore;
};

/** A memory store holding the mock CPO's sample locations and tariffs. */
export function demoLocationStore(): MemoryLocationStore {
  const store = new MemoryLocationStore();
  const seenAt = new Date().toISOString();
  // The memory store saves synchronously, so the data is there before this returns.
  void store.saveLocations(
    DEMO_PEER_ID,
    sampleLocations(DEMO_PARTY, 12),
    seenAt,
  );
  void store.saveTariffs(DEMO_PEER_ID, sampleTariffs(DEMO_PARTY), seenAt);
  return store;
}

/**
 * The locations and tariffs cache in use: Supabase in live mode; in demo mode, the mock
 * CPO's sample data in memory, for as long as the server process runs.
 */
export function locationStore(): LocationStore {
  if (holder.__emspLocationStoreOverride)
    return holder.__emspLocationStoreOverride;
  if (isDemo()) return (holder.__emspDemoLocations ??= demoLocationStore());
  return new SupabaseLocationStore(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
  );
}

/** Peers whose locations the app may see: registered peers, or the demo peer. */
export async function visiblePeerIds(): Promise<string[]> {
  if (isDemo()) return [DEMO_PEER_ID];
  return (await peerStore().listPeers())
    .filter((p) => p.status === "registered")
    .map((p) => p.id);
}

/** Tests only: use `store` instead, or go back to the default with undefined. */
export function setLocationStoreForTests(store: LocationStore | undefined) {
  holder.__emspLocationStoreOverride = store;
}
