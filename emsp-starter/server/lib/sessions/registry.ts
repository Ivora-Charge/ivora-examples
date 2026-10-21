import "server-only";
import { DEMO_PARTY, DEMO_PEER_ID } from "@/lib/locations/registry";
import { sampleCdrs, sampleSessions } from "@/lib/mock-cpo/sample-data";
import { ourParty } from "@/lib/ocpi/identity";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { MemorySessionStore, type SessionStore } from "./store";
import { SupabaseSessionStore } from "./store-supabase";

const holder = globalThis as unknown as {
  __emspDemoSessions?: MemorySessionStore;
  __emspSessionStoreOverride?: SessionStore;
};

/** A memory store holding the mock CPO's sample sessions and CDRs. */
export function demoSessionStore(): MemorySessionStore {
  const store = new MemorySessionStore();
  const now = new Date().toISOString();
  const sessions = sampleSessions(DEMO_PARTY, ourParty());
  // The memory store saves synchronously, so the data is there before this returns.
  for (const session of sessions)
    void store.insertSession(
      DEMO_PEER_ID,
      {
        session,
        fieldTimes: {},
        driverRef: null,
        commandId: null,
        completedAt: session.status === "ACTIVE" ? null : now,
      },
      now,
    );
  for (const cdr of sampleCdrs(DEMO_PARTY, sessions))
    void store.insertCdr(
      DEMO_PEER_ID,
      { cdr, driverRef: null, commandId: null, source: "pull" },
      now,
    );
  return store;
}

/**
 * The sessions and CDRs in use: Supabase in live mode; in demo mode, the mock CPO's
 * sample sessions and CDRs in memory, for as long as the server process runs.
 */
export function sessionStore(): SessionStore {
  if (holder.__emspSessionStoreOverride)
    return holder.__emspSessionStoreOverride;
  if (isDemo()) return (holder.__emspDemoSessions ??= demoSessionStore());
  return new SupabaseSessionStore(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
  );
}

/** Tests only: use `store` instead, or go back to the default with undefined. */
export function setSessionStoreForTests(store: SessionStore | undefined) {
  holder.__emspSessionStoreOverride = store;
}
