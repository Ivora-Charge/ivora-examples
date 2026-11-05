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
/** A second sample operator, in Toronto and priced in CAD, so the demo shows both currencies. */
export const DEMO_PARTY_CAD = { countryCode: "ZZ", partyId: "MCC" } as const;
/** Names of the CAD sites, so a search finds each place once. */
const DEMO_CAD_SITES = [
  { name: "Harbourfront Garage", address: "1 Lakeshore Example Blvd" },
  { name: "Maple Court Charging", address: "20 Placeholder Ave" },
];
export const DEMO_CAD_OPTIONS = {
  center: { lat: 43.6532, lng: -79.3832 },
  city: "Toronto",
  country: "CAN",
  timeZone: "America/Toronto",
  currency: "CAD",
} as const;

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
  void store.saveLocations(
    DEMO_PEER_ID,
    sampleLocations(
      DEMO_PARTY_CAD,
      DEMO_CAD_SITES.length,
      DEMO_CAD_OPTIONS,
    ).map((l, i) => ({ ...l, ...DEMO_CAD_SITES[i] })),
    seenAt,
  );
  void store.saveTariffs(
    DEMO_PEER_ID,
    sampleTariffs(DEMO_PARTY_CAD, DEMO_CAD_OPTIONS),
    seenAt,
  );
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
