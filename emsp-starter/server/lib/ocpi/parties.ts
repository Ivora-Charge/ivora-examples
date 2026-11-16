import { sameParty, type Party } from "./types";
import type { Peer } from "./store";

/**
 * Which OCPI parties a peer stands for.
 *
 * A direct CPO peer is the CPO parties in its credentials roles, as always. A roaming
 * hub (a peer whose credentials include a HUB role) connects us to CPOs that are not
 * peers themselves: the parties the operator accepted (`trusted`) are its CPO parties.
 * A party the hub merely lists (`offered`) is nobody until the operator accepts it.
 *
 * Everything that sends to a CPO or accepts something from one asks these functions,
 * so a hub's party is routed and checked the same way a direct CPO's roles are.
 */

const party = (r: { country_code: string; party_id: string }): Party => ({
  countryCode: r.country_code,
  partyId: r.party_id,
});

export const isHubPeer = (peer: Pick<Peer, "roles">): boolean =>
  peer.roles.some((r) => r.role === "HUB");

/** The hub's accepted parties. Empty for a peer that is not a hub. */
export function trustedParties(
  peer: Pick<Peer, "roles" | "hubParties">,
): Party[] {
  if (!isHubPeer(peer)) return [];
  return peer.hubParties
    .filter((p) => p.status === "trusted")
    .map((p) => ({ countryCode: p.countryCode, partyId: p.partyId }));
}

/** The CPO parties behind a peer: its CPO roles, and a hub's trusted parties. */
export function cpoParties(peer: Pick<Peer, "roles" | "hubParties">): Party[] {
  return [
    ...peer.roles.filter((r) => r.role === "CPO").map(party),
    ...trustedParties(peer),
  ];
}

export const isCpoParty = (
  peer: Pick<Peer, "roles" | "hubParties">,
  p: Party,
): boolean => cpoParties(peer).some((c) => sameParty(c, p));

/**
 * Any party that may appear in OCPI-from for this peer's token: a role of its own (a
 * hub's HUB role too) or a party trusted behind a hub.
 */
export const isPartyOfPeer = (
  peer: Pick<Peer, "roles" | "hubParties">,
  p: Party,
): boolean =>
  peer.roles.some((r) => sameParty(party(r), p)) ||
  trustedParties(peer).some((c) => sameParty(c, p));
