import "server-only";

/**
 * Which live-data adapter reads each CPO peer, and its settings. A peer with none uses
 * the null adapter. The API key is stored encrypted (manage.ts), bound to the peer.
 */
export type LiveDataSettings = {
  peerId: string;
  /** The adapter, for example "ivora" (registry.ts). */
  kind: string;
  /** The CPO's API origin, https. */
  baseUrl: string;
  /** The CPO's account on its API, for example an Ivora tenant ID. */
  accountId: string;
  /** The read-only API key, encrypted. Never leaves the server. */
  keyCiphertext: string;
  createdAt: string;
  updatedAt: string;
};

export type NewLiveDataSettings = Omit<
  LiveDataSettings,
  "createdAt" | "updatedAt"
>;

export interface LiveDataStore {
  get(peerId: string): Promise<LiveDataSettings | null>;
  list(): Promise<LiveDataSettings[]>;
  /** Creates or replaces the peer's settings. */
  put(settings: NewLiveDataSettings): Promise<LiveDataSettings>;
  /** False when the peer had none. */
  remove(peerId: string): Promise<boolean>;
}

/** In memory: for demo mode (nothing persists) and for tests. */
export class MemoryLiveDataStore implements LiveDataStore {
  readonly rows = new Map<string, LiveDataSettings>();

  async get(peerId: string) {
    const r = this.rows.get(peerId);
    return r ? { ...r } : null;
  }

  async list() {
    return [...this.rows.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => ({ ...r }));
  }

  async put(settings: NewLiveDataSettings) {
    const now = new Date().toISOString();
    const row = {
      ...settings,
      createdAt: this.rows.get(settings.peerId)?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(settings.peerId, row);
    return { ...row };
  }

  async remove(peerId: string) {
    return this.rows.delete(peerId);
  }
}
