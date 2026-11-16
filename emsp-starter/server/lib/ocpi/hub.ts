import "server-only";
import { randomUUID } from "node:crypto";
import { assertLive } from "@/lib/server/demo";
import { ocpiPages, type ClientOptions } from "./client";
import { OcpiError } from "./errors";
import { HandshakeError } from "./handshake";
import { ourParty } from "./identity";
import { isHubPeer } from "./parties";
import type { HubParty, Peer, PeerStore } from "./store";
import { decryptToken } from "./tokens";
import { sameParty, type Party } from "./types";

/**
 * The CPO parties behind a roaming hub peer, and who decides which of them we trust.
 *
 * A hub's credentials name the hub itself (role HUB). The CPOs it connects us to come
 * from the operator: `acceptParty` adds a party as trusted. The hub's own client list
 * (the hubclientinfo module, OCPI 2.2.1 section 7) can offer parties (`offerFromHub`),
 * but an offered party is not trusted: nothing is sent to it and nothing is accepted
 * from it until the operator accepts it. Party IDs are never built in: they come from
 * the operator or from the hub's list.
 */

export type HubDeps = {
  store: PeerStore;
  client?: ClientOptions;
  actor?: string;
};

const COUNTRY = /^[A-Za-z]{2}$/;
const PARTY_ID = /^[A-Za-z0-9]{3}$/;
/** Most parties offered from one hub list; the rest is ignored. */
export const MAX_OFFERED = 500;

async function hubPeer(store: PeerStore, peerId: string): Promise<Peer> {
  const peer = await store.getPeer(peerId);
  if (!peer) throw new HandshakeError("No such peer");
  if (peer.status !== "registered")
    throw new HandshakeError(`${peer.label} is ${peer.status}, not registered`);
  if (!isHubPeer(peer))
    throw new HandshakeError(`${peer.label} is not a roaming hub`);
  return peer;
}

function partyInput(input: { countryCode: string; partyId: string }): Party {
  const countryCode = input.countryCode.trim();
  const partyId = input.partyId.trim();
  if (!COUNTRY.test(countryCode))
    throw new HandshakeError("Country code must be 2 letters");
  if (!PARTY_ID.test(partyId))
    throw new HandshakeError("Party ID must be 3 letters or digits");
  return {
    countryCode: countryCode.toUpperCase(),
    partyId: partyId.toUpperCase(),
  };
}

const idOf = (p: Party) => `${p.countryCode}-${p.partyId}`;

/** Why a party cannot be a hub's CPO, or null. */
async function conflict(
  store: PeerStore,
  hub: Peer,
  party: Party,
): Promise<string | null> {
  if (sameParty(party, ourParty()))
    return "That is this eMSP's own country code and party ID";
  for (const other of await store.listPeers()) {
    if (other.id === hub.id || other.status !== "registered") continue;
    const p = (r: { country_code: string; party_id: string }) => ({
      countryCode: r.country_code,
      partyId: r.party_id,
    });
    if (other.roles.some((r) => sameParty(p(r), party)))
      return `${idOf(party)} is already registered as ${other.label}`;
    if (
      other.hubParties.some(
        (h) => h.status === "trusted" && sameParty(h, party),
      )
    )
      return `${idOf(party)} is already trusted through ${other.label}`;
  }
  return null;
}

/**
 * The operator accepts a party behind a hub: a new one, or one the hub offered. From
 * now on we send to it and accept its pushes.
 */
export async function acceptParty(
  peerId: string,
  input: { countryCode: string; partyId: string; name?: string },
  deps: HubDeps,
): Promise<Peer> {
  const peer = await hubPeer(deps.store, peerId);
  const party = partyInput(input);
  const name = input.name?.trim().slice(0, 100) || undefined;
  const why = await conflict(deps.store, peer, party);
  if (why) throw new HandshakeError(why);
  const held = peer.hubParties.find((h) => sameParty(h, party));
  const next: HubParty = {
    ...party,
    status: "trusted",
    source: held?.source ?? "admin",
    ...((name ?? held?.name) && { name: name ?? held?.name }),
  };
  const hubParties = [
    ...peer.hubParties.filter((h) => !sameParty(h, party)),
    next,
  ];
  const updated = await deps.store.updatePeer(
    peerId,
    { hubParties },
    "registered",
  );
  if (!updated) throw new HandshakeError("The peer changed; try again");
  await deps.store.audit({
    actor: deps.actor ?? "admin",
    action: "ocpi.hub.party_trusted",
    subjectId: peerId,
    details: { party: idOf(party), offered: held?.status === "offered" },
  });
  return updated;
}

/**
 * The operator stops trusting a party (or dismisses an offered one): it is removed from
 * the list, so nothing is sent to it and its pushes are refused at once. `purge`
 * removes what we cached of it (locations, tariffs).
 */
export async function removeParty(
  peerId: string,
  input: { countryCode: string; partyId: string },
  deps: HubDeps & { purge?: (peerId: string, party: Party) => Promise<void> },
): Promise<Peer> {
  const peer = await deps.store.getPeer(peerId);
  if (!peer || !isHubPeer(peer)) throw new HandshakeError("No such hub");
  const party = partyInput(input);
  const held = peer.hubParties.find((h) => sameParty(h, party));
  if (!held) throw new HandshakeError(`${idOf(party)} is not in the list`);
  const updated = await deps.store.updatePeer(peerId, {
    hubParties: peer.hubParties.filter((h) => !sameParty(h, party)),
  });
  if (!updated) throw new HandshakeError("The peer changed; try again");
  if (held.status === "trusted") await deps.purge?.(peerId, party);
  await deps.store.audit({
    actor: deps.actor ?? "admin",
    action: "ocpi.hub.party_removed",
    subjectId: peerId,
    details: { party: idOf(party), was: held.status },
  });
  return updated;
}

const CLIENT_STATUS = ["CONNECTED", "OFFLINE", "PLANNED", "SUSPENDED"];

/** CPO parties of a hubclientinfo list; entries that are not valid are skipped. */
export function cpoPartiesOfClientInfo(
  raw: unknown[],
): { party: Party; name?: string }[] {
  const out: { party: Party; name?: string }[] = [];
  for (const x of raw) {
    if (typeof x !== "object" || x === null) continue;
    const o = x as Record<string, unknown>;
    if (
      o.role !== "CPO" ||
      typeof o.country_code !== "string" ||
      typeof o.party_id !== "string" ||
      !COUNTRY.test(o.country_code) ||
      !PARTY_ID.test(o.party_id) ||
      !CLIENT_STATUS.includes(o.status as string)
    )
      continue;
    out.push({
      party: {
        countryCode: o.country_code.toUpperCase(),
        partyId: o.party_id.toUpperCase(),
      },
    });
  }
  return out;
}

/**
 * Reads the hub's client list (hubclientinfo Sender) and offers its CPO parties. New
 * ones are `offered`; trusted ones stay trusted; offered ones the hub no longer lists
 * are dropped. Returns the peer and how many parties are newly offered. Refused in demo
 * mode.
 */
export async function offerFromHub(
  peerId: string,
  deps: HubDeps,
): Promise<{ peer: Peer; offered: number }> {
  assertLive("read a roaming hub's client list");
  const peer = await hubPeer(deps.store, peerId);
  const endpoint = peer.endpoints.find(
    (e) => e.identifier === "hubclientinfo" && e.role === "SENDER",
  )?.url;
  if (!endpoint || !peer.tokenCiphertext)
    throw new HandshakeError(
      `${peer.label} has no hubclientinfo endpoint: add its parties by hand`,
    );
  const hubRole = peer.roles.find((r) => r.role === "HUB")!;
  const listed: { party: Party }[] = [];
  try {
    const pages = ocpiPages(
      {
        url: endpoint,
        token: decryptToken(peer.tokenCiphertext, peer.id),
        routing: {
          from: ourParty(),
          to: { countryCode: hubRole.country_code, partyId: hubRole.party_id },
        },
        correlationId: randomUUID(),
        maxPages: 20,
      },
      deps.client,
    );
    for await (const page of pages) {
      listed.push(...cpoPartiesOfClientInfo(page.items));
      if (listed.length >= MAX_OFFERED) break;
    }
  } catch (e) {
    throw new HandshakeError(
      e instanceof OcpiError
        ? `Reading the client list of ${peer.label} failed: ${e.message}`
        : `Reading the client list of ${peer.label} failed`,
    );
  }
  const trusted = peer.hubParties.filter((h) => h.status === "trusted");
  const known = peer.hubParties.filter((h) => h.status === "offered");
  const offers: HubParty[] = [];
  let offered = 0;
  for (const { party } of listed.slice(0, MAX_OFFERED)) {
    if (
      trusted.some((h) => sameParty(h, party)) ||
      offers.some((h) => sameParty(h, party)) ||
      sameParty(party, ourParty())
    )
      continue;
    if (!known.some((h) => sameParty(h, party))) offered++;
    offers.push({ ...party, status: "offered", source: "hubclientinfo" });
  }
  const updated = await deps.store.updatePeer(
    peerId,
    { hubParties: [...trusted, ...offers] },
    "registered",
  );
  if (!updated) throw new HandshakeError("The peer changed; try again");
  await deps.store.audit({
    actor: deps.actor ?? "admin",
    action: "ocpi.hub.parties_offered",
    subjectId: peerId,
    details: { listed: listed.length, newlyOffered: offered },
  });
  return { peer: updated, offered };
}
