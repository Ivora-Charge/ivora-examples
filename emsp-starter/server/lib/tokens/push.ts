import "server-only";
import { ocpiRequest, type ClientOptions } from "@/lib/ocpi/client";
import { OcpiError } from "@/lib/ocpi/errors";
import { ourParty } from "@/lib/ocpi/identity";
import type { Peer, PeerStore } from "@/lib/ocpi/store";
import type { Token } from "@/lib/ocpi/token-objects";
import { decryptToken } from "@/lib/ocpi/tokens";
import { ocpiTimestamp } from "@/lib/ocpi/types";
import { isDemo } from "@/lib/server/demo";
import type { DriverToken, TokenStore } from "./store";

/**
 * Pushing our tokens to every CPO's Tokens Receiver (OCPI 2.2.1 section 12.2.2):
 *
 *   PUT   {receiver}/{country_code}/{party_id}/{token_uid}?type={type}   a new token
 *   PATCH {receiver}/{country_code}/{party_id}/{token_uid}?type={type}   changed fields
 *
 * Every registered peer with a tokens RECEIVER endpoint gets every change at once, in
 * parallel. The store owes each of them the new version in the same write as the
 * change (the outbox, store.ts), and a push that lands clears it. A peer that fails
 * (down, timed out, refused), or a change whose server died before pushing, stays
 * owed: the cron route and the admin retry send the token's current version with a
 * PUT, after 1, 2, 4 ... minutes, at most 6 hours apart, until it lands. A peer that
 * pulls our Tokens Sender with date_from catches up too. Demo mode pushes nothing.
 *
 * Pushes of one token may overlap (an unblock still being retried while a block goes
 * out) and land in any order. So after every push that lands, the token is read again:
 * if it changed meanwhile, its current version goes out too, and the last push to land
 * always carries the newest version.
 */
export type PushDeps = {
  tokens: TokenStore;
  peers: PeerStore;
  client?: ClientOptions;
  now?: () => Date;
};

export type PushOutcome = {
  peerId: string;
  label: string;
  ok: boolean;
  /** Safe to show: method, host and path, and the peer's status. Never a token. */
  error?: string;
};

/** A change to push: the whole token, or the fields that changed. */
export type TokenChange =
  { method: "PUT" } | { method: "PATCH"; fields: (keyof Token)[] };

/** For pushes from an admin action: a short wait, one retry, then the queue. */
const PUSH_CLIENT: ClientOptions = { timeoutMs: 10_000, retries: 1 };

/** Follow-up pushes of newer versions, after the first, before leaving it to the queue. */
const MAX_FOLLOW_UPS = 3;

/** True while the token may charge: active and not past its expiry. */
export function tokenValid(t: DriverToken, now = new Date()): boolean {
  return (
    t.status === "active" &&
    !(t.expiresAt && Date.parse(t.expiresAt) <= now.getTime())
  );
}

/** Our token as an OCPI 2.2.1 Token object. */
export function toOcpiToken(t: DriverToken, now = new Date()): Token {
  const token: Token = {
    country_code: t.countryCode,
    party_id: t.partyId,
    uid: t.uid,
    type: t.type,
    contract_id: t.contractId,
    issuer: t.issuer,
    group_id: t.groupId,
    valid: tokenValid(t, now),
    whitelist: t.whitelist,
    last_updated: ocpiTimestamp(new Date(t.lastUpdated)),
  };
  if (t.visualNumber) token.visual_number = t.visualNumber;
  if (t.language) token.language = t.language;
  return token;
}

/** The peer's tokens Receiver URL, if it has one. */
export function tokensReceiver(peer: Peer): string | undefined {
  return peer.endpoints.find(
    (e) => e.identifier === "tokens" && e.role === "RECEIVER",
  )?.url;
}

/** Registered peers with a tokens Receiver. */
export async function tokenReceivers(peers: PeerStore): Promise<Peer[]> {
  return (await peers.listPeers()).filter(
    (p) => p.status === "registered" && p.tokenCiphertext && tokensReceiver(p),
  );
}

const errorText = (e: unknown) =>
  e instanceof OcpiError
    ? e.message.slice(0, 300)
    : e instanceof Error && "code" in e && e.code === "demo_mode"
      ? e.message
      : "unexpected error";

/** Sends one change of one token to one peer. Throws on failure. */
async function send(
  peer: Peer,
  t: DriverToken,
  change: TokenChange,
  deps: PushDeps,
  now: Date,
) {
  const url = tokensReceiver(peer)!;
  // The peer's CPO party is who the token is for; a peer with only other roles gets
  // its first one.
  const to = peer.roles.find((r) => r.role === "CPO") ?? peer.roles[0];
  const full = toOcpiToken(t, now);
  const body =
    change.method === "PUT"
      ? full
      : Object.fromEntries(
          [...change.fields, "last_updated" as const].map((f) => [f, full[f]]),
        );
  await ocpiRequest(
    {
      method: change.method,
      url: `${url.replace(/\/+$/, "")}/${[t.countryCode, t.partyId, t.uid].map(encodeURIComponent).join("/")}`,
      query: { type: t.type },
      token: decryptToken(peer.tokenCiphertext!, peer.id),
      body,
      routing: {
        from: ourParty(),
        to: { countryCode: to.country_code, partyId: to.party_id },
      },
      // The same PUT or PATCH again changes nothing: safe to repeat.
      retry: true,
    },
    deps.client ?? PUSH_CLIENT,
  );
}

async function pushTo(
  peer: Peer,
  t: DriverToken,
  change: TokenChange,
  deps: PushDeps,
  now: Date,
): Promise<PushOutcome> {
  let sent = t;
  try {
    await send(peer, sent, change, deps, now);
    for (let i = 0; i < MAX_FOLLOW_UPS; i++) {
      // Another change may have landed before this push did: send what is current now.
      const latest = await deps.tokens.getTokenById(t.id);
      if (
        !latest ||
        Date.parse(latest.lastUpdated) <= Date.parse(sent.lastUpdated)
      )
        break;
      sent = latest;
      await send(peer, sent, { method: "PUT" }, deps, now);
    }
    // Clears what the peer is owed only up to the version sent: a newer one stays queued.
    await deps.tokens.pushSucceeded(peer.id, t.id, sent.lastUpdated);
    return { peerId: peer.id, label: peer.label, ok: true };
  } catch (e) {
    const error = errorText(e);
    await deps.tokens.pushFailed({
      peerId: peer.id,
      tokenId: t.id,
      tokenLastUpdated: sent.lastUpdated,
      error,
      now: now.toISOString(),
    });
    // Name the error, not its details: they include the token's uid.
    console.error(
      `Token push to peer ${peer.id} failed, queued for retry: ${e instanceof Error ? e.name : "unknown error"}`,
    );
    return { peerId: peer.id, label: peer.label, ok: false, error };
  }
}

/** Pushes a change of `t` to every peer with a tokens Receiver, at once. */
export async function pushToken(
  t: DriverToken,
  change: TokenChange,
  deps: PushDeps,
): Promise<PushOutcome[]> {
  if (isDemo()) return [];
  const now = deps.now?.() ?? new Date();
  const peers = await tokenReceivers(deps.peers);
  return Promise.all(peers.map((p) => pushTo(p, t, change, deps, now)));
}

export type RetryReport = { sent: number; failed: number; dropped: number };

/**
 * Retries due pushes: each peer gets the token's current version with a PUT. A push
 * to a peer that is no longer registered, or no longer has a tokens Receiver, is
 * dropped: it pulls our tokens if it registers again.
 */
export async function retryPendingPushes(
  deps: PushDeps,
  { limit = 100 } = {},
): Promise<RetryReport> {
  const report: RetryReport = { sent: 0, failed: 0, dropped: 0 };
  if (isDemo()) return report;
  const now = deps.now?.() ?? new Date();
  const due = await deps.tokens.duePushes(now.toISOString(), limit);
  const peers = new Map(
    (await tokenReceivers(deps.peers)).map((p) => [p.id, p]),
  );
  for (const p of due) {
    const peer = peers.get(p.peerId);
    const t = await deps.tokens.getTokenById(p.tokenId);
    if (!peer || !t) {
      // Cleared whatever version it was owed.
      await deps.tokens.pushSucceeded(
        p.peerId,
        p.tokenId,
        "9999-12-31T23:59:59.000Z",
      );
      report.dropped++;
      continue;
    }
    const outcome = await pushTo(peer, t, { method: "PUT" }, deps, now);
    if (outcome.ok) report.sent++;
    else report.failed++;
  }
  return report;
}
