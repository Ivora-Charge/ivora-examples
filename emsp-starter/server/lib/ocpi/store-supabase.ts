import "server-only";
import {
  eq,
  supabaseRest,
  type SupabaseTransport,
} from "@/lib/server/supabase-rest";
import type {
  AuditEntry,
  AuditRecord,
  HubPushMode,
  HubRefusal,
  IssuedToken,
  NewToken,
  Peer,
  PeerPatch,
  PeerStatus,
  PeerStore,
  RefusalNote,
} from "./store";
import { MAX_REFUSED, tokenActive } from "./store";
import type { Party } from "./types";

type PeerRow = {
  id: string;
  label: string;
  direction: Peer["direction"];
  status: PeerStatus;
  versions_url: string | null;
  version: string | null;
  roles: Peer["roles"];
  endpoints: Peer["endpoints"];
  hub_parties: Peer["hubParties"];
  /** Absent before the 202611240001 migration. */
  hub_push_mode?: Peer["hubPushMode"];
  /** Absent before the 202611250001 migration. */
  push_gen?: number | string;
  token_ciphertext: string | null;
  rev: number;
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
  hubParties: r.hub_parties ?? [],
  // Before the 202611240001 migration there is no column: every hub pushes per party.
  hubPushMode: r.hub_push_mode ?? "per_party",
  pushGen: r.push_gen === undefined ? null : Number(r.push_gen),
  tokenCiphertext: r.token_ciphertext,
  rev: Number(r.rev),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  registeredAt: r.registered_at,
  unregisteredAt: r.unregistered_at,
});

/** Setup's own audit subjects (lib/setup/log.ts): "setup:job" and the like. */
const isSetupSubject = (subjectId: string) => subjectId.startsWith("setup:");

const COLUMNS: Record<keyof PeerPatch, keyof PeerRow> = {
  label: "label",
  status: "status",
  versionsUrl: "versions_url",
  version: "version",
  roles: "roles",
  endpoints: "endpoints",
  hubParties: "hub_parties",
  hubPushMode: "hub_push_mode",
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
    method: "GET" | "POST" | "PATCH" | "DELETE",
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

  async hasRegisteredPeer() {
    const rows = await this.rest<unknown[]>(
      "GET",
      "emsp_ocpi_peers?status=eq.registered&select=id&limit=1",
    );
    return rows.length > 0;
  }

  async updatePeer(
    id: string,
    patch: PeerPatch,
    ifStatus?: PeerStatus,
    ifRev?: number,
  ) {
    const body: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    for (const [k, v] of Object.entries(patch))
      body[COLUMNS[k as keyof PeerPatch]] = v;
    const filter =
      `id=${eq(id)}` +
      (ifStatus ? `&status=${eq(ifStatus)}` : "") +
      (ifRev !== undefined ? `&rev=eq.${Math.trunc(ifRev)}` : "");
    const rows = await this.rest<PeerRow[]>(
      "PATCH",
      `emsp_ocpi_peers?${filter}`,
      body,
    );
    return rows[0] ? toPeer(rows[0]) : null;
  }

  async setHubPushMode(input: {
    peerId: string;
    mode: HubPushMode;
    ifRev: number;
    now: string;
    actor: string;
  }) {
    const [row] = await this.rest<
      { peer_row: PeerRow; from_mode: HubPushMode; owed: number | string }[]
    >("POST", "rpc/emsp_ocpi_hub_set_push_mode", {
      p_peer_id: input.peerId,
      p_mode: input.mode,
      p_expected_rev: Math.trunc(input.ifRev),
      p_now: input.now,
      p_actor: input.actor,
    });
    return row
      ? {
          peer: toPeer(row.peer_row),
          from: row.from_mode,
          owed: Number(row.owed),
        }
      : null;
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
      // Setup's own entries (lib/setup/log.ts) are about no peer.
      subject_type: !entry.subjectId
        ? null
        : isSetupSubject(entry.subjectId)
          ? "setup"
          : "ocpi_peer",
      subject_id: entry.subjectId ?? null,
      request_id: entry.requestId ?? null,
      details: entry.details ?? {},
    });
  }

  async listAudit(
    subjectId: string,
    limit: number,
    action?: string,
  ): Promise<AuditRecord[]> {
    const rows = await this.rest<
      {
        occurred_at: string;
        actor: string;
        action: string;
        subject_id: string | null;
        request_id: string | null;
        details: Record<string, unknown>;
      }[]
    >(
      "GET",
      // Setup's entries are asked for with their type too, the leading column of the
      // index on (subject_type, subject_id, occurred_at).
      `emsp_audit_log?${isSetupSubject(subjectId) ? "subject_type=eq.setup&" : ""}subject_id=${eq(subjectId)}${action === undefined ? "" : `&action=${eq(action)}`}&order=occurred_at.desc,id.desc&limit=${Math.max(1, Math.floor(limit))}&select=occurred_at,actor,action,subject_id,request_id,details`,
    );
    return rows.map((r) => ({
      at: new Date(r.occurred_at).toISOString(),
      actor: r.actor,
      action: r.action,
      subjectId: r.subject_id ?? undefined,
      requestId: r.request_id ?? undefined,
      details: r.details,
    }));
  }

  async noteRefusal(note: RefusalNote) {
    const rows = await this.rest<{ noted: boolean }[]>(
      "POST",
      "rpc/emsp_ocpi_hub_refusal_note",
      {
        p_peer_id: note.peerId,
        p_country_code: note.countryCode,
        p_party_id: note.partyId,
        p_kind: note.kind,
        p_module: note.module,
        p_other_party: note.otherParty ?? null,
        p_times: Math.max(1, Math.trunc(note.times)),
      },
    );
    return Boolean(rows[0]?.noted);
  }

  async forgetRefusal(peerId: string, party: Party) {
    await this.rest(
      "DELETE",
      `emsp_ocpi_hub_refusals?peer_id=${eq(peerId)}&country_code=${eq(party.countryCode.toUpperCase())}&party_id=${eq(party.partyId.toUpperCase())}`,
    );
  }

  async listRefusals(peerId: string): Promise<HubRefusal[]> {
    const rows = await this.rest<
      {
        country_code: string;
        party_id: string;
        kind: HubRefusal["kind"];
        module: string;
        other_party: string | null;
        times: number | string;
        first_seen: string;
        last_seen: string;
      }[]
    >(
      "GET",
      `emsp_ocpi_hub_refusals?peer_id=${eq(peerId)}&order=last_seen.desc,country_code.asc,party_id.asc&limit=${MAX_REFUSED}&select=country_code,party_id,kind,module,other_party,times,first_seen,last_seen`,
    );
    return rows.map((r) => ({
      countryCode: r.country_code,
      partyId: r.party_id,
      kind: r.kind,
      module: r.module,
      ...(r.other_party && { otherParty: r.other_party }),
      times: Number(r.times),
      firstSeen: new Date(r.first_seen).toISOString(),
      lastSeen: new Date(r.last_seen).toISOString(),
    }));
  }
}
