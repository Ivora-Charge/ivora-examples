import "server-only";
import { DEMO_PEER_ID } from "@/lib/locations/registry";
import { decryptToken } from "@/lib/ocpi/tokens";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { nullAdapter, type LiveDataAdapter } from "./adapter";
import { demoAdapter } from "./demo";
import { IVORA_KEY_PATTERN, ivoraAdapter } from "./ivora";
import { MemoryLiveDataStore, type LiveDataStore } from "./store";
import { SupabaseLiveDataStore } from "./store-supabase";

/** What an admin gives for a peer's adapter. `apiKey` is the plain key: secret. */
export type AdapterInput = {
  baseUrl: string;
  accountId: string;
  apiKey: string;
};

/**
 * The adapters this server knows, by kind. To add one for another CPO, write a
 * `LiveDataAdapter` (see ivora.ts) and add it here; the admin page lists every kind.
 */
export type AdapterKind = {
  /** Shown in the admin web. */
  label: string;
  /** What `accountId` is at this CPO, for the admin form. */
  accountLabel: string;
  accountPattern: RegExp;
  keyPattern: RegExp;
  create(input: AdapterInput): LiveDataAdapter;
};

export const ADAPTER_KINDS: Record<string, AdapterKind> = {
  ivora: {
    label: "Ivora API",
    accountLabel: "Tenant ID",
    accountPattern: /^\d{1,18}$/,
    keyPattern: IVORA_KEY_PATTERN,
    create: (s) =>
      ivoraAdapter({
        baseUrl: s.baseUrl,
        tenantId: s.accountId,
        apiKey: s.apiKey,
      }),
  },
};

/** The encryption context of a peer's API key: a ciphertext moved to another row, or to a peer token, does not decrypt. */
export const keyContext = (peerId: string) => `live-data:${peerId}`;

const holder = globalThis as unknown as {
  __emspDemoLiveData?: MemoryLiveDataStore;
  __emspLiveDataOverride?: LiveDataStore;
  __emspLiveAdapters?: Map<
    string,
    { version: string; adapter: LiveDataAdapter }
  >;
};

/** The adapter settings in use: Supabase in live mode, memory in demo mode. */
export function liveDataStore(): LiveDataStore {
  if (holder.__emspLiveDataOverride) return holder.__emspLiveDataOverride;
  if (isDemo())
    return (holder.__emspDemoLiveData ??= new MemoryLiveDataStore());
  return new SupabaseLiveDataStore(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
  );
}

/** Tests only: use `store` instead, or go back to the default with undefined. */
export function setLiveDataStoreForTests(store: LiveDataStore | undefined) {
  holder.__emspLiveDataOverride = store;
  holder.__emspLiveAdapters = undefined;
}

/**
 * The adapter for a peer: in demo mode, the demo adapter for the mock CPO; otherwise
 * the peer's configured adapter, or the null adapter. An adapter is kept while its
 * settings stay the same, so its cache lasts across requests.
 */
export async function adapterFor(
  peerId: string,
  store: LiveDataStore = liveDataStore(),
): Promise<LiveDataAdapter> {
  if (isDemo()) return peerId === DEMO_PEER_ID ? demoAdapter() : nullAdapter;
  const settings = await store.get(peerId);
  if (!settings) return nullAdapter;
  const kind = ADAPTER_KINDS[settings.kind];
  if (!kind) {
    console.warn(
      `Live data: peer ${peerId} names an unknown adapter, ${settings.kind}; nothing shown`,
    );
    return nullAdapter;
  }
  const cache = (holder.__emspLiveAdapters ??= new Map());
  const version = `${settings.kind}:${settings.updatedAt}`;
  const cached = cache.get(peerId);
  if (cached?.version === version) return cached.adapter;
  const adapter = kind.create({
    baseUrl: settings.baseUrl,
    accountId: settings.accountId,
    apiKey: decryptToken(settings.keyCiphertext, keyContext(peerId)),
  });
  cache.set(peerId, { version, adapter });
  return adapter;
}
