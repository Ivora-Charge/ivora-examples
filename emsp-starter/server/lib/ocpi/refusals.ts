import "server-only";
import { logText } from "@/lib/server/log-error";
import { ABSENT_CODES, DatabaseRequestError } from "@/lib/server/supabase-rest";
import { OcpiProblem } from "./errors";
import { ourParty } from "./identity";
import { isCpoParty, isHubPeer } from "./parties";
import {
  MAX_NEW_REFUSED,
  MAX_REFUSED,
  REFUSAL_WINDOW_MS,
  refusalListFull,
  type Peer,
  type PeerStore,
  type RefusalKind,
} from "./store";
import { sameParty, STATUS, type Party } from "./types";

/**
 * Refused pushes from parties behind a roaming hub that the operator has not accepted.
 *
 * Such a push gets 403 / OCPI 2000, as before. Additionally, so the hub's page can say
 * "a party sent us data and was refused" and offer to accept it, the refusal is noted:
 * one row per (hub peer, party) with the reason, the module, a count and when it was
 * first and last seen (store.ts HubRefusal). Nothing of the request beyond the parties
 * is kept: no body, token, header value or IP address.
 *
 * Only a peer with a valid token gets this far, and the writes are bounded anyway, both
 * in this process and in the database function (whatever the number of server
 * instances):
 * - a party's refusals are written at most once per REFUSAL_WINDOW_MS (in this
 *   process, refusals in between are added to the next write);
 * - a hub gets at most MAX_NEW_REFUSED new parties per REFUSAL_WINDOW_MS, so a sender
 *   that names a new party on every request cannot flush the list;
 * - at most MAX_REFUSED parties are kept per hub: a new party replaces the one seen
 *   longest ago, but never one seen within REFUSAL_KEEP_MS (24 h); when all were, the
 *   new party is dropped, so a sustained flood cannot displace active rows.
 * Counts are therefore a lower bound. The 403 waits at most REFUSAL_WRITE_WAIT_MS for
 * the write, and after a "table missing" answer (migration pending) this process
 * writes nothing for ABSENT_BACKOFF_MS.
 */

/** The parties of a refused request, as noteRefused reads them. */
export type Refused = {
  party: Party;
  kind: RefusalKind;
  /** The other party of the request, when it differs: OCPI-from or the URL's. */
  other?: Party;
};

/** A 403 for a push in the name of a party this peer may not send for. */
export class RefusedPartyProblem extends OcpiProblem {
  constructor(
    message: string,
    readonly refused: Refused,
  ) {
    super(403, STATUS.CLIENT_ERROR, message);
  }
}

const RECEIVER_PATH =
  /^\/ocpi\/2\.2\.1\/(?:locations|tariffs|sessions)\/([A-Za-z]{2})\/([A-Za-z0-9]{3})(?:\/|$)/;

/** The country code and party ID in a receiver URL path, upper case, if it has them. */
export function pathParty(url: string): Party | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const m = RECEIVER_PATH.exec(path);
  return m
    ? { countryCode: m[1].toUpperCase(), partyId: m[2].toUpperCase() }
    : undefined;
}

/** The module of an OCPI URL ("locations"), or "other". */
export function moduleOf(url: string): string {
  try {
    const m = /^\/ocpi\/[^/]+\/([a-z]{1,20})(?:\/|$)/.exec(
      new URL(url).pathname,
    );
    return m ? m[1] : "other";
  } catch {
    return "other";
  }
}

const id = (p: Party) => `${p.countryCode}-${p.partyId}`;
const upper = (p: Party): Party => ({
  countryCode: p.countryCode.toUpperCase(),
  partyId: p.partyId.toUpperCase(),
});

/**
 * Whether a refusal is worth noting: a hub peer, a party in the OCPI format that the
 * operator could accept (not this eMSP, not a party the hub already has trusted, not
 * the hub's own party), and a request that sends data (not a GET).
 */
function worthNoting(peer: Peer, method: string, r: Refused): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS")
    return false;
  if (!isHubPeer(peer)) return false;
  const p = r.party;
  if (!/^[A-Z]{2}$/.test(p.countryCode) || !/^[A-Z0-9]{3}$/.test(p.partyId))
    return false;
  if (sameParty(p, ourParty()) || isCpoParty(peer, p)) return false;
  return !peer.roles.some(
    (x) =>
      x.role === "HUB" &&
      sameParty({ countryCode: x.country_code, partyId: x.party_id }, p),
  );
}

/** Most parties this process keeps a last-write time for; the oldest go first. */
const MAX_TRACKED = 1000;
/** How long the 403 waits for the write; a slower write goes on without it. */
export const REFUSAL_WRITE_WAIT_MS = 1500;
/** After a "table missing" answer, this process writes nothing for this long. */
export const ABSENT_BACKOFF_MS = 10 * 60_000;

type Pending = { lastWriteMs: number; pending: number };
type State = {
  /** Per (peer, party): the last write and the refusals since. */
  writes: Map<string, Pending>;
  /** Per peer: when new parties were last written, within the window. */
  fresh: Map<string, number[]>;
  /** No write before this time (the migration is pending). */
  absentUntilMs: number;
  /** Per peer: when a dropped new party was last logged as a full list. */
  fullLogged: Map<string, number>;
};
const holder = globalThis as unknown as { __emspRefusals?: State };
const state = (): State =>
  (holder.__emspRefusals ??= {
    writes: new Map(),
    fresh: new Map(),
    absentUntilMs: 0,
    fullLogged: new Map(),
  });

/** Tests only: forget this process's write times and back-off. */
export function resetRefusalWritesForTests(): void {
  delete holder.__emspRefusals;
}

/**
 * Whether peer `peerId` may get one more new party at `ms` (MAX_NEW_REFUSED per
 * REFUSAL_WINDOW_MS); if so, counts it.
 */
function takeNew(peerId: string, ms: number): boolean {
  const { fresh } = state();
  const recent = (fresh.get(peerId) ?? []).filter(
    (t) => ms - t < REFUSAL_WINDOW_MS,
  );
  if (recent.length >= MAX_NEW_REFUSED) {
    fresh.set(peerId, recent);
    return false;
  }
  recent.push(ms);
  // Re-inserted, so the map's order is least recently used first.
  fresh.delete(peerId);
  fresh.set(peerId, recent);
  while (fresh.size > MAX_TRACKED) fresh.delete(fresh.keys().next().value!);
  return true;
}

/**
 * After a new party was not written: when the cause is a full list (not the budget of
 * new parties), logs it, at most once per REFUSAL_WINDOW_MS per hub. Names the hub and
 * the count, never the party. The list is read only when a log is due. Never throws.
 */
async function logIfFull(
  store: PeerStore,
  peerId: string,
  ms: number,
): Promise<void> {
  const { fullLogged } = state();
  const last = fullLogged.get(peerId);
  if (last !== undefined && ms - last < REFUSAL_WINDOW_MS) return;
  // Claimed before the read, so concurrent drops read the list once.
  fullLogged.delete(peerId);
  fullLogged.set(peerId, ms);
  while (fullLogged.size > MAX_TRACKED)
    fullLogged.delete(fullLogged.keys().next().value!);
  try {
    if (refusalListFull(await store.listRefusals(peerId), ms))
      console.error(
        `The refused-party list of peer ${peerId} is full (${MAX_REFUSED} parties, all seen in the last 24 hours): new refused parties are dropped. Dismiss or accept rows on the hub's page to make room.`,
      );
  } catch {
    // The list is only read for this log line; a failed read says nothing.
  }
}

const isAbsent = (e: unknown) =>
  e instanceof DatabaseRequestError &&
  e.code !== null &&
  ABSENT_CODES.has(e.code);

/**
 * Notes a refused request of a hub peer, when worth noting (see worthNoting). Never
 * throws, never changes the answer the peer gets and waits at most
 * REFUSAL_WRITE_WAIT_MS for the write: a failed write is logged by name only.
 */
export async function noteRefused(
  store: PeerStore,
  peer: Peer,
  request: Request,
  refused: Refused,
  now: () => number = Date.now,
): Promise<void> {
  const r: Refused = {
    kind: refused.kind,
    party: upper(refused.party),
    ...(refused.other && { other: upper(refused.other) }),
  };
  if (!worthNoting(peer, request.method, r)) return;
  const st = state();
  const ms = now();
  if (ms < st.absentUntilMs) return;
  const key = `${peer.id}|${id(r.party)}`;
  const map = st.writes;
  const held = map.get(key);
  if (held && ms - held.lastWriteMs < REFUSAL_WINDOW_MS) {
    held.pending++;
    return;
  }
  // A party this process has not written lately counts against the hub's budget of
  // new parties; over it, nothing is written or remembered.
  if (!held && !takeNew(peer.id, ms)) return;
  // Re-inserted, so the map's order is oldest write first.
  map.delete(key);
  map.set(key, { lastWriteMs: ms, pending: 0 });
  while (map.size > MAX_TRACKED) map.delete(map.keys().next().value!);
  // Through a promise, so a store that throws synchronously is a failed write too.
  const write = Promise.resolve()
    .then(() =>
      store.noteRefusal({
        peerId: peer.id,
        countryCode: r.party.countryCode,
        partyId: r.party.partyId,
        kind: r.kind,
        module: moduleOf(request.url),
        ...(r.other &&
          !sameParty(r.other, r.party) && { otherParty: id(r.other) }),
        times: 1 + (held?.pending ?? 0),
        at: new Date(ms).toISOString(),
      }),
    )
    .then(
      (noted) => {
        if (!noted && !held) return logIfFull(store, peer.id, ms);
      },
      (e: unknown) => {
        const absent = isAbsent(e);
        if (absent) st.absentUntilMs = ms + ABSENT_BACKOFF_MS;
        console.error(
          `Noting a refused push from ${id(r.party)} through peer ${peer.id} failed: ${logText(e)}${absent ? ". Apply the pending database migration (Setup, stop 2, names it); refused pushes are not noted for the next 10 minutes." : ""}`,
        );
      },
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    write,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, REFUSAL_WRITE_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
}
