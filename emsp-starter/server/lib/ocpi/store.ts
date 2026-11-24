import "server-only";
import { randomUUID } from "node:crypto";
import type { CredentialsRole, Endpoint, Party } from "./types";

/**
 * The peer registry: every CPO this eMSP is connected to (or is connecting to), with
 * its roles, its endpoints per module, the token it gave us (encrypted) and the hashes
 * of the tokens we gave it.
 *
 * - `outbound`: we registered at the peer (we had its Token A).
 * - `inbound`: the peer registered with us (we issued a Token A).
 */
export type PeerStatus = "pending" | "registered" | "unregistered" | "failed";
export type PeerDirection = "outbound" | "inbound";

/**
 * A CPO party reachable through a hub peer. `offered`: the hub lists it, the operator
 * has not accepted it, so we pull nothing from it, send it no command (and no token in
 * per-party mode) and accept nothing from it. `trusted`: the operator accepted it.
 */
export type HubParty = {
  countryCode: string;
  partyId: string;
  status: "offered" | "trusted";
  /**
   * Who added it: the operator, the hub's client list (hubclientinfo), or a CPO role
   * in the hub's own credentials. Only the operator makes a party trusted.
   */
  source: "admin" | "hubclientinfo" | "credentials";
  name?: string;
  /**
   * When the operator accepted it (UTC, ISO 8601): "Trusted since 12 Nov". Kept in the
   * hub_parties data, so no column. Absent on a party accepted before this was kept.
   */
  trustedAt?: string;
};

/**
 * `hub`: one push to the hub's own HUB party, which distributes it. `per_party`: one
 * push per trusted CPO party behind the hub.
 */
export type HubPushMode = "hub" | "per_party";

export type Peer = {
  id: string;
  label: string;
  direction: PeerDirection;
  status: PeerStatus;
  /** The peer's versions endpoint. */
  versionsUrl: string | null;
  /** The OCPI version both sides use, once registered. */
  version: string | null;
  roles: CredentialsRole[];
  endpoints: Endpoint[];
  /** For a hub peer: the parties behind it (parties.ts). Empty for a direct CPO. */
  hubParties: HubParty[];
  /**
   * For a hub peer: how our token pushes are addressed (tokens/push.ts). New peers
   * start with `hub`; hubs registered before this setting existed stay `per_party`.
   */
  hubPushMode: HubPushMode;
  /**
   * Raised by every push-mode switch. A token push carries the one it started under and
   * only clears an outbox row owed in that generation or an older one, so a push that
   * was under way during a switch cannot clear what the switch re-owed. Null on a
   * database without the 202611250001 migration.
   */
  pushGen: number | null;
  /** The token we send to the peer, encrypted (tokens.ts). Never leaves the server. */
  tokenCiphertext: string | null;
  /**
   * Raised by one on every update: the version for compare-and-set (`ifRev`). Not the
   * OCPI `version` above.
   */
  rev: number;
  createdAt: string;
  updatedAt: string;
  registeredAt: string | null;
  unregisteredAt: string | null;
};

export type PeerPatch = Partial<
  Pick<
    Peer,
    | "label"
    | "status"
    | "versionsUrl"
    | "version"
    | "roles"
    | "endpoints"
    | "hubParties"
    | "hubPushMode"
    | "tokenCiphertext"
    | "registeredAt"
    | "unregisteredAt"
  >
>;

/**
 * - `registration`: a Token A we issued. Valid for versions and the credentials POST only.
 * - `full`: a Token B or C we issued. Valid for every module once the peer is registered.
 */
export type TokenScope = "registration" | "full";

export type IssuedToken = {
  hash: string;
  peerId: string;
  scope: TokenScope;
  createdAt: string;
  /** After this the token no longer works. Set for a Token A; null for B and C. */
  expiresAt: string | null;
};

export type NewToken = Omit<IssuedToken, "createdAt" | "expiresAt"> & {
  expiresAt?: string | null;
};

/** Active: not revoked and not expired. */
export const tokenActive = (
  t: { revokedAt?: string | null; expiresAt: string | null },
  now = Date.now(),
) => !t.revokedAt && (!t.expiresAt || Date.parse(t.expiresAt) > now);

export type AuditEntry = {
  actor: string;
  action: string;
  subjectId?: string;
  requestId?: string;
  /** Never tokens, secrets or card data. */
  details?: Record<string, unknown>;
};

/** An audit log entry as read back, newest first. */
export type AuditRecord = AuditEntry & { at: string };

/**
 * Why a hub's push was refused: `routing`, its OCPI-from party is not trusted behind
 * the hub; `path`, the party of the URL or body is not the OCPI-from party.
 */
export type RefusalKind = "routing" | "path";

/**
 * Refused pushes of one party behind a hub peer (refusals.ts): who, why, how often and
 * when. No request body, token, header value or IP address.
 */
export type HubRefusal = {
  /** The refused party, upper case. */
  countryCode: string;
  partyId: string;
  kind: RefusalKind;
  /** The OCPI module of the last refused request. */
  module: string;
  /** The other party of the last refused request ("NL-HUB"), when the two differ. */
  otherParty?: string;
  /** Refusals counted: a lower bound (at most one write per party per window). */
  times: number;
  firstSeen: string;
  lastSeen: string;
};

/**
 * One write of `times` refusals of a party (refusals.ts). `at` is this process's clock:
 * the memory store uses it, the database uses its own (now()).
 */
export type RefusalNote = Omit<
  HubRefusal,
  "firstSeen" | "lastSeen" | "otherParty"
> & {
  peerId: string;
  otherParty?: string;
  at: string;
};

/**
 * Most refused parties kept per hub peer. A new party past that replaces the one seen
 * longest ago, but never one seen within REFUSAL_KEEP_MS: then the new one is dropped.
 */
export const MAX_REFUSED = 100;
/** A refused party seen this recently is never replaced by a new one (also in the SQL). */
export const REFUSAL_KEEP_MS = 24 * 60 * 60_000;
/**
 * Whether a hub's refused-party list is full: MAX_REFUSED rows, none replaceable (all
 * seen within REFUSAL_KEEP_MS, 24 h counted in: a row is replaceable only once it is
 * strictly older). A new party is then dropped, so the list says it is full. Worked out
 * from the rows, no column; `rows` is what listRefusals returned.
 */
export function refusalListFull(
  rows: { lastSeen: string }[],
  nowMs: number,
): boolean {
  return (
    rows.length >= MAX_REFUSED &&
    rows.every((r) => nowMs - Date.parse(r.lastSeen) <= REFUSAL_KEEP_MS)
  );
}
/** A party's refusals are written at most once per this window (also in the SQL). */
export const REFUSAL_WINDOW_MS = 60_000;
/** Most new refused parties a hub peer gets per REFUSAL_WINDOW_MS (also in the SQL). */
export const MAX_NEW_REFUSED = 10;

export interface PeerStore {
  createPeer(input: {
    label: string;
    direction: PeerDirection;
    versionsUrl?: string;
  }): Promise<Peer>;
  getPeer(id: string): Promise<Peer | null>;
  listPeers(): Promise<Peer[]>;
  /** Whether any peer is registered, by reading at most one row. */
  hasRegisteredPeer(): Promise<boolean>;
  /**
   * Changes a peer. With `ifStatus`, only when the peer still has that status: returns
   * null otherwise, so two concurrent handshakes cannot both win. With `ifRev`,
   * only when the peer still has that `rev` (nobody changed it since it was read:
   * compare-and-set).
   */
  updatePeer(
    id: string,
    patch: PeerPatch,
    ifStatus?: PeerStatus,
    ifRev?: number,
  ): Promise<Peer | null>;
  /**
   * Switches a registered peer's hub push mode, if it still has revision `ifRev`, and
   * audits it, as one atomic step. Switching to `hub` also owes the peer every token
   * (active and blocked) through the token outbox, due at `now` (the catch-up), when it
   * has a token and a tokens Receiver. Every push already owed to the peer moves to the
   * new push generation. Returns null when the peer changed or is not registered, or
   * already has the mode; nothing is written then. Throws when it could not complete,
   * or the peer has no HUB role: nothing is written either.
   */
  setHubPushMode(input: {
    peerId: string;
    mode: HubPushMode;
    ifRev: number;
    now: string;
    actor: string;
  }): Promise<{ peer: Peer; from: HubPushMode; owed: number } | null>;
  issueToken(token: NewToken): Promise<void>;
  /** An active (not revoked, not expired) token by its hash. */
  findToken(hash: string): Promise<IssuedToken | null>;
  revokeToken(hash: string): Promise<void>;
  /** Revokes every active token of the peer, except `keepHash`. */
  revokePeerTokens(peerId: string, keepHash?: string): Promise<void>;
  audit(entry: AuditEntry): Promise<void>;
  /**
   * The audit log of one subject (a payment, a token, a peer), newest first; with
   * `action`, its entries of that action only.
   */
  listAudit(
    subjectId: string,
    limit: number,
    action?: string,
  ): Promise<AuditRecord[]>;
  /**
   * Notes refusals of a party behind a hub peer: a new row, or one more count on the
   * party's row. Writes nothing (and returns false) within REFUSAL_WINDOW_MS of the
   * row's last write, nor for a new party once the peer got MAX_NEW_REFUSED new rows
   * within REFUSAL_WINDOW_MS; keeps at most MAX_REFUSED rows per peer, replacing only
   * rows not seen within REFUSAL_KEEP_MS (else the new party is dropped). A 'routing'
   * row keeps its kind.
   */
  noteRefusal(note: RefusalNote): Promise<boolean>;
  /** Forgets a party's refusals at a hub peer (it was accepted). */
  forgetRefusal(peerId: string, party: Party): Promise<void>;
  /** A hub peer's refused parties, seen most recently first. */
  listRefusals(peerId: string): Promise<HubRefusal[]>;
}

/** Peers in memory: for demo mode (nothing persists) and for tests. */
export class MemoryPeerStore implements PeerStore {
  readonly peers = new Map<string, Peer>();
  readonly tokens = new Map<string, IssuedToken & { revokedAt?: string }>();
  readonly auditLog: AuditRecord[] = [];
  readonly refusals = new Map<string, HubRefusal & { peerId: string }>();

  async createPeer(input: {
    label: string;
    direction: PeerDirection;
    versionsUrl?: string;
  }): Promise<Peer> {
    const now = new Date().toISOString();
    const peer: Peer = {
      id: randomUUID(),
      label: input.label,
      direction: input.direction,
      status: "pending",
      versionsUrl: input.versionsUrl ?? null,
      version: null,
      roles: [],
      endpoints: [],
      hubParties: [],
      // Like the column default: a peer registered now starts with pushes to the hub.
      hubPushMode: "hub",
      pushGen: 0,
      tokenCiphertext: null,
      rev: 0,
      createdAt: now,
      updatedAt: now,
      registeredAt: null,
      unregisteredAt: null,
    };
    this.peers.set(peer.id, peer);
    return structuredClone(peer);
  }

  async getPeer(id: string) {
    const p = this.peers.get(id);
    return p ? structuredClone(p) : null;
  }

  async listPeers() {
    return [...this.peers.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((p) => structuredClone(p));
  }

  async hasRegisteredPeer() {
    return [...this.peers.values()].some((p) => p.status === "registered");
  }

  async updatePeer(
    id: string,
    patch: PeerPatch,
    ifStatus?: PeerStatus,
    ifRev?: number,
  ) {
    const p = this.peers.get(id);
    if (!p || (ifStatus && p.status !== ifStatus)) return null;
    if (ifRev !== undefined && p.rev !== ifRev) return null;
    Object.assign(p, structuredClone(patch), {
      rev: p.rev + 1,
      updatedAt: new Date().toISOString(),
    });
    return structuredClone(p);
  }

  /**
   * Set by a MemoryTokenStore made over this store: owes `peerId` every token in
   * generation `gen`, and moves the pushes already owed to it to `gen`. Returns how many
   * tokens it owes. Nothing awaits in it or in setHubPushMode, so the switch, the
   * catch-up and the audit are one step, like the database function.
   */
  catchUp?: (peerId: string, gen: number, now: string, owe: boolean) => number;

  async setHubPushMode(input: {
    peerId: string;
    mode: HubPushMode;
    ifRev: number;
    now: string;
    actor: string;
  }) {
    const p = this.peers.get(input.peerId);
    if (
      !p ||
      p.status !== "registered" ||
      p.rev !== input.ifRev ||
      p.hubPushMode === input.mode
    )
      return null;
    // Like the database function: the push mode is only for a roaming hub.
    if (!p.roles.some((r) => r.role === "HUB"))
      throw new Error(`peer ${p.id} is not a roaming hub`);
    const from = p.hubPushMode;
    const before = structuredClone(p);
    p.hubPushMode = input.mode;
    p.pushGen = (p.pushGen ?? 0) + 1;
    p.rev += 1;
    p.updatedAt = input.now;
    const owe =
      input.mode === "hub" &&
      !!p.tokenCiphertext &&
      p.endpoints.some(
        (e) => e.identifier === "tokens" && e.role === "RECEIVER",
      );
    let owed = 0;
    try {
      owed = this.catchUp?.(p.id, p.pushGen, input.now, owe) ?? 0;
    } catch (e) {
      // All or nothing, like the transaction.
      Object.assign(p, before);
      throw e;
    }
    this.auditLog.push({
      at: input.now,
      actor: input.actor,
      action: "ocpi.hub.push_mode_set",
      subjectId: p.id,
      details: { mode: input.mode, from, owed },
    });
    return { peer: structuredClone(p), from, owed };
  }

  async issueToken(token: NewToken) {
    if (this.tokens.has(token.hash)) throw new Error("token hash collision");
    this.tokens.set(token.hash, {
      ...token,
      expiresAt: token.expiresAt ?? null,
      createdAt: new Date().toISOString(),
    });
  }

  async findToken(hash: string) {
    const t = this.tokens.get(hash);
    if (!t || !tokenActive(t)) return null;
    const { revokedAt: _, ...token } = t;
    return token;
  }

  async revokeToken(hash: string) {
    const t = this.tokens.get(hash);
    if (t && !t.revokedAt) t.revokedAt = new Date().toISOString();
  }

  async revokePeerTokens(peerId: string, keepHash?: string) {
    for (const t of this.tokens.values())
      if (t.peerId === peerId && t.hash !== keepHash && !t.revokedAt)
        t.revokedAt = new Date().toISOString();
  }

  async audit(entry: AuditEntry) {
    this.auditLog.push({
      ...structuredClone(entry),
      at: new Date().toISOString(),
    });
  }

  async listAudit(subjectId: string, limit: number, action?: string) {
    return this.auditLog
      .filter(
        (e) =>
          e.subjectId === subjectId &&
          (action === undefined || e.action === action),
      )
      .reverse()
      .slice(0, limit)
      .map((e) => structuredClone(e));
  }

  async noteRefusal(note: RefusalNote) {
    const key = `${note.peerId}|${note.countryCode}-${note.partyId}`;
    const held = this.refusals.get(key);
    const at = Date.parse(note.at);
    if (held && at - Date.parse(held.lastSeen) < REFUSAL_WINDOW_MS)
      return false;
    if (
      !held &&
      [...this.refusals.values()].filter(
        (r) =>
          r.peerId === note.peerId &&
          at - Date.parse(r.firstSeen) < REFUSAL_WINDOW_MS,
      ).length >= MAX_NEW_REFUSED
    )
      return false;
    // Synchronous from the checks to the write, so concurrent notes cannot overshoot
    // the budget or the cap, nor drop each other's rows.
    if (!held) {
      const mine = this.sortedRefusals(note.peerId);
      if (mine.length >= MAX_REFUSED) {
        const stale = mine
          .filter((r) => at - Date.parse(r.lastSeen) > REFUSAL_KEEP_MS)
          .sort(
            (a, b) =>
              a.lastSeen.localeCompare(b.lastSeen) ||
              a.countryCode.localeCompare(b.countryCode) ||
              a.partyId.localeCompare(b.partyId),
          )
          .slice(0, mine.length - MAX_REFUSED + 1);
        if (mine.length - stale.length >= MAX_REFUSED) return false;
        for (const r of stale)
          this.refusals.delete(`${note.peerId}|${r.countryCode}-${r.partyId}`);
      }
    }
    const { at: seen, otherParty, ...rest } = note;
    this.refusals.set(key, {
      ...rest,
      kind: held?.kind === "routing" ? "routing" : note.kind,
      ...(otherParty && { otherParty }),
      times: (held?.times ?? 0) + Math.max(1, note.times),
      firstSeen: held?.firstSeen ?? seen,
      lastSeen: seen,
    });
    return true;
  }

  private sortedRefusals(peerId: string) {
    return [...this.refusals.values()]
      .filter((r) => r.peerId === peerId)
      .sort(
        (a, b) =>
          b.lastSeen.localeCompare(a.lastSeen) ||
          a.countryCode.localeCompare(b.countryCode) ||
          a.partyId.localeCompare(b.partyId),
      );
  }

  async forgetRefusal(peerId: string, party: Party) {
    this.refusals.delete(
      `${peerId}|${party.countryCode.toUpperCase()}-${party.partyId.toUpperCase()}`,
    );
  }

  async listRefusals(peerId: string) {
    return this.sortedRefusals(peerId)
      .slice(0, MAX_REFUSED)
      .map(({ peerId: _, ...r }) => structuredClone(r));
  }
}
