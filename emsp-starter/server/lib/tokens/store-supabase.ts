import "server-only";
import { randomUUID } from "node:crypto";
import type { WhitelistType } from "@/lib/ocpi/token-objects";
import {
  eq,
  supabaseRest,
  type SupabaseTransport,
} from "@/lib/server/supabase-rest";
import type {
  DriverToken,
  DriverTokenType,
  NewDriverToken,
  PageQuery,
  PendingPush,
  TokenPatch,
  TokenStatus,
  TokenStore,
} from "./store";

type TokenRow = {
  id: string;
  country_code: string;
  party_id: string;
  uid: string;
  type: DriverTokenType;
  contract_id: string;
  driver_ref: string;
  visual_number: string | null;
  group_id: string;
  issuer: string;
  whitelist: WhitelistType;
  language: string | null;
  status: TokenStatus;
  expires_at: string | null;
  last_updated: string;
  created_at: string;
  revision: string;
};

type PushRow = {
  peer_id: string;
  token_id: string;
  token_last_updated: string;
  attempts: number;
  last_error: string;
  next_attempt_at: string;
};

/** Postgres returns `+00:00`; the rest of the server works with `Z` ISO strings. */
const iso = (v: string) => new Date(v).toISOString();
const isoOrNull = (v: string | null) => (v === null ? null : iso(v));

const token = (r: TokenRow): DriverToken => ({
  id: r.id,
  countryCode: r.country_code,
  partyId: r.party_id,
  uid: r.uid,
  type: r.type,
  contractId: r.contract_id,
  driverRef: r.driver_ref,
  visualNumber: r.visual_number,
  groupId: r.group_id,
  issuer: r.issuer,
  whitelist: r.whitelist,
  language: r.language,
  status: r.status,
  expiresAt: isoOrNull(r.expires_at),
  lastUpdated: iso(r.last_updated),
  createdAt: iso(r.created_at),
  revision: r.revision,
});

const push = (r: PushRow): PendingPush => ({
  peerId: r.peer_id,
  tokenId: r.token_id,
  tokenLastUpdated: iso(r.token_last_updated),
  attempts: r.attempts,
  lastError: r.last_error,
  nextAttemptAt: iso(r.next_attempt_at),
});

const ORDER = "order=last_updated.asc,id.asc";
const enc = encodeURIComponent;

/**
 * Tokens and the push queue in Supabase Postgres (emsp_tokens, emsp_token_pushes),
 * through the Data API as the service role. A change writes with compare-and-swap on
 * the row's revision, so two admins blocking and unblocking at once never lose one.
 */
export class SupabaseTokenStore implements TokenStore {
  private readonly rest: ReturnType<typeof supabaseRest>;

  constructor(
    url: string,
    serviceRoleKey: string,
    transport?: SupabaseTransport,
  ) {
    this.rest = supabaseRest(url, serviceRoleKey, transport);
  }

  async insertToken(t: NewDriverToken) {
    const [row] = await this.rest<TokenRow[]>(
      "POST",
      "emsp_tokens?on_conflict=uid,type&select=*",
      {
        country_code: t.countryCode,
        party_id: t.partyId,
        uid: t.uid,
        type: t.type,
        contract_id: t.contractId,
        driver_ref: t.driverRef,
        visual_number: t.visualNumber,
        group_id: t.groupId,
        issuer: t.issuer,
        whitelist: t.whitelist,
        language: t.language,
        expires_at: t.expiresAt,
        last_updated: t.lastUpdated,
      },
      "resolution=ignore-duplicates,return=representation",
    );
    return row ? token(row) : null;
  }

  async getToken(uid: string, type: DriverTokenType) {
    const [row] = await this.rest<TokenRow[]>(
      "GET",
      `emsp_tokens?uid=${eq(uid)}&type=${eq(type)}&select=*`,
    );
    return row ? token(row) : null;
  }

  async getTokenById(id: string) {
    const [row] = await this.rest<TokenRow[]>(
      "GET",
      `emsp_tokens?id=${eq(id)}&select=*`,
    );
    return row ? token(row) : null;
  }

  async listByDriver(driverRef: string) {
    const rows = await this.rest<TokenRow[]>(
      "GET",
      `emsp_tokens?driver_ref=${eq(driverRef)}&select=*&order=type.asc,created_at.asc`,
    );
    // APP_USER sorts before RFID.
    return rows.map(token);
  }

  async updateToken(id: string, patch: TokenPatch, expectedRevision: string) {
    const body: Record<string, unknown> = {
      last_updated: patch.lastUpdated,
      revision: randomUUID(),
    };
    if (patch.status !== undefined) body.status = patch.status;
    if (patch.whitelist !== undefined) body.whitelist = patch.whitelist;
    if (patch.expiresAt !== undefined) body.expires_at = patch.expiresAt;
    const [row] = await this.rest<TokenRow[]>(
      "PATCH",
      `emsp_tokens?id=${eq(id)}&revision=${eq(expectedRevision)}&select=*`,
      body,
      "return=representation",
    );
    return row ? token(row) : null;
  }

  async page({ dateFrom, dateTo, offset, limit }: PageQuery) {
    const filters = [
      dateFrom ? `last_updated=gte.${enc(dateFrom)}` : "",
      dateTo ? `last_updated=lt.${enc(dateTo)}` : "",
    ]
      .filter(Boolean)
      .map((f) => `${f}&`)
      .join("");
    const [rows, [count]] = await Promise.all([
      this.rest<TokenRow[]>(
        "GET",
        `emsp_tokens?${filters}select=*&${ORDER}&offset=${offset}&limit=${limit}`,
      ),
      this.rest<{ total: number | string }[]>("POST", "rpc/emsp_tokens_count", {
        p_date_from: dateFrom ?? null,
        p_date_to: dateTo ?? null,
      }),
    ]);
    return { tokens: rows.map(token), total: Number(count?.total ?? 0) };
  }

  async listExpired(now: string, limit: number) {
    const rows = await this.rest<TokenRow[]>(
      "GET",
      `emsp_tokens?status=eq.active&expires_at=lte.${enc(now)}&select=*&order=expires_at.asc&limit=${limit}`,
    );
    return rows.map(token);
  }

  async pushFailed(input: {
    peerId: string;
    tokenId: string;
    tokenLastUpdated: string;
    error: string;
    now: string;
  }) {
    await this.rest("POST", "rpc/emsp_token_push_failed", {
      p_peer_id: input.peerId,
      p_token_id: input.tokenId,
      p_token_last_updated: input.tokenLastUpdated,
      p_error: input.error,
      p_now: input.now,
    });
  }

  async pushSucceeded(
    peerId: string,
    tokenId: string,
    pushedLastUpdated: string,
  ) {
    await this.rest(
      "DELETE",
      `emsp_token_pushes?peer_id=${eq(peerId)}&token_id=${eq(tokenId)}&token_last_updated=lte.${enc(pushedLastUpdated)}`,
      undefined,
      "return=minimal",
    );
  }

  async duePushes(now: string, limit: number) {
    const rows = await this.rest<PushRow[]>(
      "GET",
      `emsp_token_pushes?next_attempt_at=lte.${enc(now)}&select=*&order=next_attempt_at.asc&limit=${limit}`,
    );
    return rows.map(push);
  }

  async countPendingPushes(max: number) {
    const rows = await this.rest<unknown[]>(
      "GET",
      `emsp_token_pushes?select=token_id&limit=${max}`,
    );
    return rows.length;
  }
}
