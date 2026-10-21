import "server-only";
import { randomUUID } from "node:crypto";
import type { CredentialsRole, Endpoint } from "./types";

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
  /** The token we send to the peer, encrypted (tokens.ts). Never leaves the server. */
  tokenCiphertext: string | null;
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

export interface PeerStore {
  createPeer(input: {
    label: string;
    direction: PeerDirection;
    versionsUrl?: string;
  }): Promise<Peer>;
  getPeer(id: string): Promise<Peer | null>;
  listPeers(): Promise<Peer[]>;
  /**
   * Changes a peer. With `ifStatus`, only when the peer still has that status: returns
   * null otherwise, so two concurrent handshakes cannot both win.
   */
  updatePeer(
    id: string,
    patch: PeerPatch,
    ifStatus?: PeerStatus,
  ): Promise<Peer | null>;
  issueToken(token: NewToken): Promise<void>;
  /** An active (not revoked, not expired) token by its hash. */
  findToken(hash: string): Promise<IssuedToken | null>;
  revokeToken(hash: string): Promise<void>;
  /** Revokes every active token of the peer, except `keepHash`. */
  revokePeerTokens(peerId: string, keepHash?: string): Promise<void>;
  audit(entry: AuditEntry): Promise<void>;
}

/** Peers in memory: for demo mode (nothing persists) and for tests. */
export class MemoryPeerStore implements PeerStore {
  readonly peers = new Map<string, Peer>();
  readonly tokens = new Map<string, IssuedToken & { revokedAt?: string }>();
  readonly auditLog: (AuditEntry & { at: string })[] = [];

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
      tokenCiphertext: null,
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

  async updatePeer(id: string, patch: PeerPatch, ifStatus?: PeerStatus) {
    const p = this.peers.get(id);
    if (!p || (ifStatus && p.status !== ifStatus)) return null;
    Object.assign(p, structuredClone(patch), {
      updatedAt: new Date().toISOString(),
    });
    return structuredClone(p);
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
}
