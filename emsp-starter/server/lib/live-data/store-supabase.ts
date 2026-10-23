import "server-only";
import {
  eq,
  supabaseRest,
  type SupabaseTransport,
} from "@/lib/server/supabase-rest";
import type {
  LiveDataSettings,
  LiveDataStore,
  NewLiveDataSettings,
} from "./store";

type Row = {
  peer_id: string;
  kind: string;
  base_url: string;
  account_id: string;
  key_ciphertext: string;
  created_at: string;
  updated_at: string;
};

const toSettings = (r: Row): LiveDataSettings => ({
  peerId: r.peer_id,
  kind: r.kind,
  baseUrl: r.base_url,
  accountId: r.account_id,
  keyCiphertext: r.key_ciphertext,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const TABLE = "emsp_live_data_adapters";

/** Live-data adapter settings in Supabase Postgres, as the service role. */
export class SupabaseLiveDataStore implements LiveDataStore {
  private readonly rest: ReturnType<typeof supabaseRest>;

  constructor(
    url: string,
    serviceRoleKey: string,
    transport?: SupabaseTransport,
  ) {
    this.rest = supabaseRest(url, serviceRoleKey, transport);
  }

  async get(peerId: string) {
    const rows = await this.rest<Row[]>(
      "GET",
      `${TABLE}?peer_id=${eq(peerId)}&select=*`,
    );
    return rows[0] ? toSettings(rows[0]) : null;
  }

  async list() {
    const rows = await this.rest<Row[]>(
      "GET",
      `${TABLE}?select=*&order=created_at.asc`,
    );
    return rows.map(toSettings);
  }

  async put(s: NewLiveDataSettings) {
    const values = {
      kind: s.kind,
      base_url: s.baseUrl,
      account_id: s.accountId,
      key_ciphertext: s.keyCiphertext,
    };
    // Update, else insert; an insert that lost a race to another one updates after all.
    for (let attempt = 0; attempt < 2; attempt++) {
      const [updated] = await this.rest<Row[]>(
        "PATCH",
        `${TABLE}?peer_id=${eq(s.peerId)}`,
        { ...values, updated_at: new Date().toISOString() },
        "return=representation",
      );
      if (updated) return toSettings(updated);
      const [inserted] = await this.rest<Row[]>(
        "POST",
        `${TABLE}?on_conflict=peer_id`,
        { peer_id: s.peerId, ...values },
        "return=representation,resolution=ignore-duplicates",
      );
      if (inserted) return toSettings(inserted);
    }
    throw new Error("Live-data settings could not be saved");
  }

  async remove(peerId: string) {
    const rows = await this.rest<Row[]>(
      "DELETE",
      `${TABLE}?peer_id=${eq(peerId)}`,
      undefined,
      "return=representation",
    );
    return rows.length > 0;
  }
}
