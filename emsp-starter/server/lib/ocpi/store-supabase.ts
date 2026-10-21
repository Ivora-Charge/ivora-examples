import "server-only";
import {
  eq,
  supabaseRest,
  type SupabaseTransport,
} from "@/lib/server/supabase-rest";
import type {
  AuditEntry,
  IssuedToken,
  NewToken,
  Peer,
  PeerPatch,
  PeerStatus,
  PeerStore,
} from "./store";
import { tokenActive } from "./store";

type PeerRow = {
  id: string;
  label: string;
  direction: Peer["direction"];
  status: PeerStatus;
  versions_url: string | null;
  version: string | null;
  roles: Peer["roles"];
  endpoints: Peer["endpoints"];
  token_ciphertext: string | null;
  created_at: string;
  updated_at: string;
  registered_at: string | null;
  unregistered_at: string | null;
};

const toPeer = (r: PeerRow): Peer => ({
  id: r.id,
  label: r.label,
  direction: r.direction,
  status: r.status,
  versionsUrl: r.versions_url,
  version: r.version,
  roles: r.roles,
  endpoints: r.endpoints,
  tokenCiphertext: r.token_ciphertext,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  registeredAt: r.registered_at,
  unregisteredAt: r.unregistered_at,
});

const COLUMNS: Record<keyof PeerPatch, keyof PeerRow> = {
  label: "label",
  status: "status",
  versionsUrl: "versions_url",
  version: "version",
  roles: "roles",
  endpoints: "endpoints",
  tokenCiphertext: "token_ciphertext",
  registeredAt: "registered_at",
  unregisteredAt: "unregistered_at",
};

/**
 * The peer registry in Supabase Postgres, through the Data API (PostgREST) as the
 * service role (supabase-rest.ts: never in demo mode, errors without keys or values).
 */
export class SupabasePeerStore implements PeerStore {
  private readonly rest: <T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ) => Promise<T>;

  constructor(
    url: string,
    serviceRoleKey: string,
    transport?: SupabaseTransport,
  ) {
    const rest = supabaseRest(url, serviceRoleKey, transport);
    // Writes return the changed rows.
    this.rest = (method, path, body) =>
      rest(
        method,
        path,
        body,
        body === undefined ? undefined : "return=representation",
      );
  }

  async createPeer(input: {
    label: string;
    direction: Peer["direction"];
    versionsUrl?: string;
  }) {
    const [row] = await this.rest<PeerRow[]>("POST", "emsp_ocpi_peers", {
      label: input.label,
      direction: input.direction,
      versions_url: input.versionsUrl ?? null,
    });
    return toPeer(row);
  }

  async getPeer(id: string) {
    const rows = await this.rest<PeerRow[]>(
      "GET",
      `emsp_ocpi_peers?id=${eq(id)}&select=*`,
    );
    return rows[0] ? toPeer(rows[0]) : null;
  }

  async listPeers() {
    const rows = await this.rest<PeerRow[]>(
      "GET",
      "emsp_ocpi_peers?select=*&order=created_at.asc",
    );
    return rows.map(toPeer);
  }

  async updatePeer(id: string, patch: PeerPatch, ifStatus?: PeerStatus) {
    const body: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    for (const [k, v] of Object.entries(patch))
      body[COLUMNS[k as keyof PeerPatch]] = v;
    const filter = `id=${eq(id)}${ifStatus ? `&status=${eq(ifStatus)}` : ""}`;
    const rows = await this.rest<PeerRow[]>(
      "PATCH",
      `emsp_ocpi_peers?${filter}`,
      body,
    );
    return rows[0] ? toPeer(rows[0]) : null;
  }

  async issueToken(token: NewToken) {
    await this.rest("POST", "emsp_ocpi_issued_tokens", {
      token_hash: token.hash,
      peer_id: token.peerId,
      scope: token.scope,
      expires_at: token.expiresAt ?? null,
    });
  }

  async findToken(hash: string) {
    const rows = await this.rest<
      {
        token_hash: string;
        peer_id: string;
        scope: IssuedToken["scope"];
        created_at: string;
        expires_at: string | null;
      }[]
    >(
      "GET",
      `emsp_ocpi_issued_tokens?token_hash=${eq(hash)}&revoked_at=is.null&select=token_hash,peer_id,scope,created_at,expires_at`,
    );
    const r = rows[0];
    return r && tokenActive({ expiresAt: r.expires_at })
      ? {
          hash: r.token_hash,
          peerId: r.peer_id,
          scope: r.scope,
          createdAt: r.created_at,
          expiresAt: r.expires_at,
        }
      : null;
  }

  async revokeToken(hash: string) {
    await this.rest(
      "PATCH",
      `emsp_ocpi_issued_tokens?token_hash=${eq(hash)}&revoked_at=is.null`,
      { revoked_at: new Date().toISOString() },
    );
  }

  async revokePeerTokens(peerId: string, keepHash?: string) {
    const keep = keepHash
      ? `&token_hash=neq.${encodeURIComponent(keepHash)}`
      : "";
    await this.rest(
      "PATCH",
      `emsp_ocpi_issued_tokens?peer_id=${eq(peerId)}&revoked_at=is.null${keep}`,
      { revoked_at: new Date().toISOString() },
    );
  }

  async audit(entry: AuditEntry) {
    await this.rest("POST", "emsp_audit_log", {
      actor: entry.actor,
      action: entry.action,
      subject_type: entry.subjectId ? "ocpi_peer" : null,
      subject_id: entry.subjectId ?? null,
      request_id: entry.requestId ?? null,
      details: entry.details ?? {},
    });
  }
}
