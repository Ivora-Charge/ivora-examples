import "server-only";
import { brand } from "@/brand";
import { config, DEMO_PARTY } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { MemoryTokenStore, type TokenStore } from "./store";
import { SupabaseTokenStore } from "./store-supabase";

/** The driver demo mode shows, with an app token and an RFID card. */
export const DEMO_DRIVER_REF = "demo-driver";

const holder = globalThis as unknown as {
  __emspDemoTokens?: MemoryTokenStore;
  __emspTokenStoreOverride?: TokenStore;
};

/** A memory store holding the demo driver's tokens. */
export function demoTokenStore(): MemoryTokenStore {
  const store = new MemoryTokenStore();
  const common = {
    countryCode: DEMO_PARTY.countryCode,
    partyId: DEMO_PARTY.partyId,
    contractId: "ZZDMOCDEMO0001",
    driverRef: DEMO_DRIVER_REF,
    groupId: "ZZDMOCDEMO0001",
    issuer: brand.name,
    whitelist: "ALLOWED_OFFLINE",
    language: "en",
    expiresAt: null,
    lastUpdated: new Date().toISOString(),
  } as const;
  // The memory store inserts synchronously, so the data is there before this returns.
  void store.insertToken({
    ...common,
    uid: "DEMOAPPUSER0001",
    type: "APP_USER",
    visualNumber: null,
  });
  void store.insertToken({
    ...common,
    uid: "04A1B2C3D4E5F6",
    type: "RFID",
    visualNumber: "DEMO-0001",
    whitelist: "NEVER", // RFID cards are NEVER until RFID billing (manage.ts)
  });
  return store;
}

/**
 * The token store in use: Supabase in live mode; in demo mode, the demo driver's tokens
 * in memory, for as long as the server process runs.
 */
export function tokenStore(): TokenStore {
  if (holder.__emspTokenStoreOverride) return holder.__emspTokenStoreOverride;
  if (isDemo()) return (holder.__emspDemoTokens ??= demoTokenStore());
  return new SupabaseTokenStore(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
  );
}

/** Tests only: use `store` instead, or go back to the default with undefined. */
export function setTokenStoreForTests(store: TokenStore | undefined) {
  holder.__emspTokenStoreOverride = store;
}
