import "server-only";
import { logText } from "@/lib/server/log-error";
import { ABSENT_CODES, DatabaseRequestError } from "@/lib/server/supabase-rest";
import { OcpiProblem } from "./errors";
import { ourParty } from "./identity";
import { isCpoParty, isHubPeer } from "./parties";
import {
  REFUSAL_WINDOW_MS,
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
 * Only a peer with a valid token gets this far, and the writes are bounded anyway: in
 * this process a party's refusals are written at most once per REFUSAL_WINDOW_MS
 * (refusals in between are added to the next write), and the database function
 * writes at most once per party per window whatever the number of server instances.
 * Counts are therefore a lower bound. At most MAX_REFUSED parties are kept per hub.
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

type Pending = { lastWriteMs: number; pending: number };
const holder = globalThis as unknown as {
  __emspRefusalWrites?: Map<string, Pending>;
};
const writes = () => (holder.__emspRefusalWrites ??= new Map());

/** Tests only: forget this process's last-write times. */
export function resetRefusalWritesForTests(): void {
  writes().clear();
}

/**
 * Notes a refused request of a hub peer, when worth noting (see worthNoting). Never
 * throws and never changes the answer the peer gets: a failed write is logged by
 * name only.
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
  const key = `${peer.id}|${id(r.party)}`;
  const map = writes();
  const ms = now();
  const held = map.get(key);
  if (held && ms - held.lastWriteMs < REFUSAL_WINDOW_MS) {
    held.pending++;
    return;
  }
  // Re-inserted, so the map's order is oldest write first.
  map.delete(key);
  map.set(key, { lastWriteMs: ms, pending: 0 });
  while (map.size > MAX_TRACKED) map.delete(map.keys().next().value!);
  try {
    await store.noteRefusal({
      peerId: peer.id,
      countryCode: r.party.countryCode,
      partyId: r.party.partyId,
      kind: r.kind,
      module: moduleOf(request.url),
      ...(r.other &&
        !sameParty(r.other, r.party) && { otherParty: id(r.other) }),
      times: 1 + (held?.pending ?? 0),
      at: new Date(ms).toISOString(),
    });
  } catch (e) {
    const absent =
      e instanceof DatabaseRequestError &&
      e.code !== null &&
      ABSENT_CODES.has(e.code);
    console.error(
      `Noting a refused push from ${id(r.party)} through peer ${peer.id} failed: ${logText(e)}${absent ? ". Apply the pending database migration (Setup, stop 2, names it)." : ""}`,
    );
  }
}
