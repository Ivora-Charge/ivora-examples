import "server-only";
import { randomUUID } from "node:crypto";
import type { WhitelistType } from "@/lib/ocpi/token-objects";

/**
 * Our drivers' tokens: what this eMSP issues and CPOs authorize against. Each driver
 * (`driverRef`, the account's ID once driver sign-in lands) has one APP_USER token
 * with its contract ID, and any number of RFID cards that share that contract ID and
 * group ID.
 *
 * Also the push queue: a peer that missed a token change (its Tokens Receiver failed)
 * is owed the token's current version, and gets it on the next retry.
 */
export type DriverTokenType = "APP_USER" | "RFID";
export type TokenStatus = "active" | "blocked" | "expired";

export type DriverToken = {
  id: string;
  countryCode: string;
  partyId: string;
  /** Upper case. Unique per type. */
  uid: string;
  type: DriverTokenType;
  /** eMA ID, the same for every token of a driver (contract-id.ts). */
  contractId: string;
  driverRef: string;
  visualNumber: string | null;
  groupId: string;
  issuer: string;
  whitelist: WhitelistType;
  language: string | null;
  status: TokenStatus;
  /** After this the token answers EXPIRED (an RFID card's end date, say). */
  expiresAt: string | null;
  /** OCPI last_updated: moves forward by at least a second on every change. */
  lastUpdated: string;
  createdAt: string;
  /** Changes with every change: the compare-and-swap token for updateToken. */
  revision: string;
};

export type NewDriverToken = Omit<
  DriverToken,
  "id" | "createdAt" | "revision" | "status"
>;

export type TokenPatch = Partial<
  Pick<DriverToken, "status" | "whitelist" | "expiresAt">
> & { lastUpdated: string };

export type TokenPage = { tokens: DriverToken[]; total: number };

export type PageQuery = {
  /** Inclusive. */
  dateFrom?: string;
  /** Exclusive. */
  dateTo?: string;
  offset: number;
  limit: number;
};

/** A peer owed the current version of a token. */
export type PendingPush = {
  peerId: string;
  tokenId: string;
  /** The token's last_updated when the push failed: a later success clears it. */
  tokenLastUpdated: string;
  attempts: number;
  /** Safe to show: no tokens or peer data. */
  lastError: string;
  nextAttemptAt: string;
};

/** Longest wait between retries of a failed push. */
export const MAX_PUSH_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** Wait before the next retry after `attempts` failures: 1, 2, 4 ... minutes, at most 6 hours. */
export const pushBackoffMs = (attempts: number) =>
  Math.min(MAX_PUSH_BACKOFF_MS, 60_000 * 2 ** Math.max(0, attempts - 1));

export interface TokenStore {
  /** Null when a token with this uid and type exists already. */
  insertToken(token: NewDriverToken): Promise<DriverToken | null>;
  getToken(uid: string, type: DriverTokenType): Promise<DriverToken | null>;
  getTokenById(id: string): Promise<DriverToken | null>;
  /** A driver's tokens, APP_USER first, then by creation. */
  listByDriver(driverRef: string): Promise<DriverToken[]>;
  /**
   * Changes a token only if its revision is still `expectedRevision`. Null when another
   * change got there first: read again and retry.
   */
  updateToken(
    id: string,
    patch: TokenPatch,
    expectedRevision: string,
  ): Promise<DriverToken | null>;
  /** Tokens with last_updated in [dateFrom, dateTo), oldest first, and how many in all. */
  page(query: PageQuery): Promise<TokenPage>;
  /** Active tokens whose expiresAt has passed, at most `limit`. */
  listExpired(now: string, limit: number): Promise<DriverToken[]>;

  /** Records a failed push; the next retry waits longer after each failure. */
  pushFailed(input: {
    peerId: string;
    tokenId: string;
    tokenLastUpdated: string;
    error: string;
    now: string;
  }): Promise<void>;
  /** Clears what the peer is owed, unless the token changed again since `pushedLastUpdated`. */
  pushSucceeded(
    peerId: string,
    tokenId: string,
    pushedLastUpdated: string,
  ): Promise<void>;
  /** Pushes to retry now, oldest first. */
  duePushes(now: string, limit: number): Promise<PendingPush[]>;
  /** How many pushes are owed, counting at most `max`. */
  countPendingPushes(max: number): Promise<number>;
}

const ms = (iso: string) => Date.parse(iso);

/** Tokens in memory: for demo mode (nothing persists) and for tests. */
export class MemoryTokenStore implements TokenStore {
  readonly tokens = new Map<string, DriverToken>();
  readonly pushes = new Map<string, PendingPush>();

  async insertToken(t: NewDriverToken) {
    for (const held of this.tokens.values()) {
      if (held.uid === t.uid && held.type === t.type) return null;
      // Like the database's unique indexes: one APP_USER per driver, one contract per driver.
      if (
        t.type === "APP_USER" &&
        held.type === "APP_USER" &&
        (held.driverRef === t.driverRef || held.contractId === t.contractId)
      )
        throw new Error("duplicate driver or contract");
    }
    const token: DriverToken = {
      ...structuredClone(t),
      id: randomUUID(),
      status: "active",
      createdAt: new Date().toISOString(),
      revision: randomUUID(),
    };
    this.tokens.set(token.id, token);
    return structuredClone(token);
  }

  async getToken(uid: string, type: DriverTokenType) {
    for (const t of this.tokens.values())
      if (t.uid === uid && t.type === type) return structuredClone(t);
    return null;
  }

  async getTokenById(id: string) {
    const t = this.tokens.get(id);
    return t ? structuredClone(t) : null;
  }

  async listByDriver(driverRef: string) {
    return [...this.tokens.values()]
      .filter((t) => t.driverRef === driverRef)
      .sort(
        (a, b) =>
          Number(b.type === "APP_USER") - Number(a.type === "APP_USER") ||
          a.createdAt.localeCompare(b.createdAt),
      )
      .map((t) => structuredClone(t));
  }

  async updateToken(id: string, patch: TokenPatch, expectedRevision: string) {
    const t = this.tokens.get(id);
    if (!t || t.revision !== expectedRevision) return null;
    Object.assign(t, structuredClone(patch), { revision: randomUUID() });
    return structuredClone(t);
  }

  async page({ dateFrom, dateTo, offset, limit }: PageQuery) {
    const all = [...this.tokens.values()]
      .filter(
        (t) =>
          (!dateFrom || ms(t.lastUpdated) >= ms(dateFrom)) &&
          (!dateTo || ms(t.lastUpdated) < ms(dateTo)),
      )
      .sort(
        (a, b) =>
          ms(a.lastUpdated) - ms(b.lastUpdated) || a.id.localeCompare(b.id),
      );
    return {
      tokens: all.slice(offset, offset + limit).map((t) => structuredClone(t)),
      total: all.length,
    };
  }

  async listExpired(now: string, limit: number) {
    return [...this.tokens.values()]
      .filter(
        (t) =>
          t.status === "active" && t.expiresAt && ms(t.expiresAt) <= ms(now),
      )
      .slice(0, limit)
      .map((t) => structuredClone(t));
  }

  async pushFailed(input: {
    peerId: string;
    tokenId: string;
    tokenLastUpdated: string;
    error: string;
    now: string;
  }) {
    const key = `${input.peerId}:${input.tokenId}`;
    const held = this.pushes.get(key);
    const attempts = (held?.attempts ?? 0) + 1;
    this.pushes.set(key, {
      peerId: input.peerId,
      tokenId: input.tokenId,
      tokenLastUpdated:
        held && ms(held.tokenLastUpdated) > ms(input.tokenLastUpdated)
          ? held.tokenLastUpdated
          : input.tokenLastUpdated,
      attempts,
      lastError: input.error,
      nextAttemptAt: new Date(
        ms(input.now) + pushBackoffMs(attempts),
      ).toISOString(),
    });
  }

  async pushSucceeded(
    peerId: string,
    tokenId: string,
    pushedLastUpdated: string,
  ) {
    const key = `${peerId}:${tokenId}`;
    const held = this.pushes.get(key);
    if (held && ms(held.tokenLastUpdated) <= ms(pushedLastUpdated))
      this.pushes.delete(key);
  }

  async duePushes(now: string, limit: number) {
    return [...this.pushes.values()]
      .filter((p) => ms(p.nextAttemptAt) <= ms(now))
      .sort((a, b) => ms(a.nextAttemptAt) - ms(b.nextAttemptAt))
      .slice(0, limit)
      .map((p) => structuredClone(p));
  }

  async countPendingPushes(max: number) {
    return Math.min(max, this.pushes.size);
  }
}
