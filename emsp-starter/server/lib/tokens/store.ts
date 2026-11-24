import "server-only";
import { randomUUID } from "node:crypto";
import { MemoryPeerStore, type PeerStore } from "@/lib/ocpi/store";
import type { WhitelistType } from "@/lib/ocpi/token-objects";
import { tokenReceivers } from "./push";

/**
 * Our drivers' tokens: what this eMSP issues and CPOs authorize against. Each driver
 * (`driverRef`, the account's ID once driver sign-in lands) has one APP_USER token
 * with its contract ID, and any number of RFID cards that share that contract ID and
 * group ID.
 *
 * Also the push outbox: inserting or changing a token records, in the same write, that
 * every registered peer with a tokens Receiver is owed the new version. A successful
 * push clears that; a failed one (or a server that died before pushing) leaves it for
 * the retry job, which sends the token's current version.
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
  /** The newest version owed: a push of it, or of a later one, clears it. */
  tokenLastUpdated: string;
  /** Failed attempts: 0 while the first push is still under way. */
  attempts: number;
  /** Safe to show: no tokens or peer data. */
  lastError: string;
  nextAttemptAt: string;
  /**
   * The peer's push generation the push is owed in (Peer.pushGen). A push started under
   * an older one does not clear it.
   */
  pushGen: number;
};

/** Longest wait between retries of a failed push. */
export const MAX_PUSH_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** Wait before the next retry after `attempts` failures: 1, 2, 4 ... minutes, at most 6 hours. */
export const pushBackoffMs = (attempts: number) =>
  Math.min(MAX_PUSH_BACKOFF_MS, 60_000 * 2 ** Math.max(0, attempts - 1));

/** How long a change's first push may take before the retry job sends it instead. */
export const FIRST_PUSH_GRACE_MS = 60_000;

export interface TokenStore {
  /**
   * Null when a token with this uid and type exists already. Like updateToken, owes
   * the token to every peer with a tokens Receiver, in the same write.
   */
  insertToken(token: NewDriverToken): Promise<DriverToken | null>;
  getToken(uid: string, type: DriverTokenType): Promise<DriverToken | null>;
  getTokenById(id: string): Promise<DriverToken | null>;
  /** A driver's tokens, APP_USER first, then by creation. */
  listByDriver(driverRef: string): Promise<DriverToken[]>;
  /**
   * Changes a token only if its revision is still `expectedRevision`. Null when another
   * change got there first: read again and retry. A change owes the new version to
   * every peer with a tokens Receiver, in the same write (the outbox).
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
  /**
   * Clears what the peer is owed, unless the token changed again since
   * `pushedLastUpdated`, or the peer's push mode was switched since the push started
   * (the push was made under push generation `pushGen`, Peer.pushGen; null on a
   * database without the generation: no check).
   */
  pushSucceeded(
    peerId: string,
    tokenId: string,
    pushedLastUpdated: string,
    pushGen: number | null,
  ): Promise<void>;
  /** Pushes to retry now, oldest first. */
  duePushes(now: string, limit: number): Promise<PendingPush[]>;
  /** How many pushes are owed, counting at most `max`. */
  countPendingPushes(max: number): Promise<number>;
}

const ms = (iso: string) => Date.parse(iso);

/**
 * Tokens in memory: for demo mode (nothing persists) and for tests. With `peers`, it
 * keeps the outbox like the database's trigger does; demo mode pushes nothing and
 * passes none.
 */
export class MemoryTokenStore implements TokenStore {
  readonly tokens = new Map<string, DriverToken>();
  readonly pushes = new Map<string, PendingPush>();

  constructor(private readonly peers?: PeerStore) {
    // The hub push-mode switch owes through this outbox in its own step (MemoryPeerStore).
    if (peers instanceof MemoryPeerStore)
      peers.catchUp = (peerId, gen, now, owe) =>
        this.catchUp(peerId, gen, now, owe);
  }

  private async receivers(): Promise<{ id: string; gen: number }[]> {
    return (await tokenReceivers(this.peers!)).map((p) => ({
      id: p.id,
      gen: p.pushGen ?? 0,
    }));
  }

  /**
   * The database's emsp_ocpi_hub_set_push_mode: moves the pushes owed to `peerId` to
   * generation `gen`, and with `owe` owes it every token, blocked ones too.
   */
  private catchUp(peerId: string, gen: number, now: string, owe: boolean) {
    for (const p of this.pushes.values())
      if (p.peerId === peerId) p.pushGen = gen;
    if (!owe) return 0;
    for (const t of this.tokens.values())
      this.owe(t, [{ id: peerId, gen }], now);
    return this.tokens.size;
  }

  /**
   * Owes `t` to `peerIds`: the database's emsp_tokens_owe_push trigger (due after the
   * first push's grace), or emsp_token_owe_active (due at `dueAt`).
   */
  private owe(
    t: DriverToken,
    peers: { id: string; gen: number }[],
    dueAt?: string,
  ) {
    const due = dueAt ? ms(dueAt) : ms(t.lastUpdated) + FIRST_PUSH_GRACE_MS;
    for (const { id: peerId, gen } of peers) {
      const key = `${peerId}:${t.id}`;
      const held = this.pushes.get(key);
      this.pushes.set(key, {
        peerId,
        tokenId: t.id,
        tokenLastUpdated:
          held && ms(held.tokenLastUpdated) > ms(t.lastUpdated)
            ? held.tokenLastUpdated
            : t.lastUpdated,
        attempts: held?.attempts ?? 0,
        lastError: held?.lastError ?? "",
        nextAttemptAt: new Date(
          held ? Math.min(ms(held.nextAttemptAt), due) : due,
        ).toISOString(),
        pushGen: Math.max(held?.pushGen ?? 0, gen),
      });
    }
  }

  async insertToken(t: NewDriverToken) {
    // Reads the peers first: from here on nothing awaits, so the check and the writes
    // are one step, like a transaction. Without peers nothing awaits at all, which
    // demoTokenStore relies on.
    const owed = this.peers ? await this.receivers() : [];
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
    this.owe(token, owed);
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
    const owed = this.peers ? await this.receivers() : [];
    const t = this.tokens.get(id);
    if (!t || t.revision !== expectedRevision) return null;
    Object.assign(t, structuredClone(patch), { revision: randomUUID() });
    this.owe(t, owed);
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
      // A failure never lowers the generation; a row made by it is the oldest.
      pushGen: held?.pushGen ?? 0,
    });
  }

  async pushSucceeded(
    peerId: string,
    tokenId: string,
    pushedLastUpdated: string,
    pushGen: number | null,
  ) {
    const key = `${peerId}:${tokenId}`;
    const held = this.pushes.get(key);
    if (
      held &&
      ms(held.tokenLastUpdated) <= ms(pushedLastUpdated) &&
      (pushGen === null || held.pushGen <= pushGen)
    )
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
