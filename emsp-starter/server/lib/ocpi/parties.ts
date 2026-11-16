import { sameParty, type CredentialsRole, type Party } from "./types";
import type { HubParty, Peer, PeerStore } from "./store";

/**
 * Which OCPI parties a peer stands for.
 *
 * A direct CPO peer is the CPO parties in its credentials roles, as always. A roaming
 * hub (a peer whose credentials include a HUB role) connects us to CPOs that are not
 * peers themselves: ONLY the parties the operator accepted (`trusted`) are its CPO
 * parties. A party the hub lists (`offered`), in its client list or as a CPO role in its
 * own credentials, is nobody until the operator accepts it: a hub cannot make a party
 * trusted by declaring it.
 *
 * Everything that sends to a CPO or accepts something from one asks these functions,
 * so a hub's party is routed and checked the same way a direct CPO's roles are.
 */

const party = (r: { country_code: string; party_id: string }): Party => ({
  countryCode: r.country_code,
  partyId: r.party_id,
});

export const isHubRoles = (roles: Pick<CredentialsRole, "role">[]): boolean =>
  roles.some((r) => r.role === "HUB");

export const isHubPeer = (peer: Pick<Peer, "roles">): boolean =>
  isHubRoles(peer.roles);

/** The hub's accepted parties. Empty for a peer that is not a hub. */
export function trustedParties(
  peer: Pick<Peer, "roles" | "hubParties">,
): Party[] {
  if (!isHubPeer(peer)) return [];
  return peer.hubParties
    .filter((p) => p.status === "trusted")
    .map((p) => ({ countryCode: p.countryCode, partyId: p.partyId }));
}

/**
 * The CPO parties behind a peer: a direct CPO's CPO roles, or a hub's trusted parties
 * (never the CPO roles a hub declares).
 */
export function cpoParties(peer: Pick<Peer, "roles" | "hubParties">): Party[] {
  if (isHubPeer(peer)) return trustedParties(peer);
  return peer.roles.filter((r) => r.role === "CPO").map(party);
}

export const isCpoParty = (
  peer: Pick<Peer, "roles" | "hubParties">,
  p: Party,
): boolean => cpoParties(peer).some((c) => sameParty(c, p));

/**
 * Any party that may appear in OCPI-from for this peer's token: for a direct peer, a
 * role of its own; for a hub, its HUB role or a party the operator trusts behind it.
 */
export const isPartyOfPeer = (
  peer: Pick<Peer, "roles" | "hubParties">,
  p: Party,
): boolean =>
  isHubPeer(peer)
    ? peer.roles.some((r) => r.role === "HUB" && sameParty(party(r), p)) ||
      trustedParties(peer).some((c) => sameParty(c, p))
    : peer.roles.some((r) => sameParty(party(r), p));

/**
 * The CPO roles a hub declares in its credentials, added to its list as `offered` (new
 * ones only: a party already in the list keeps its status). Never trusted by this.
 */
export function offerDeclaredParties(
  list: HubParty[],
  roles: CredentialsRole[],
): HubParty[] {
  const out = [...list];
  for (const r of roles) {
    if (r.role !== "CPO") continue;
    const p = party(r);
    if (out.some((h) => sameParty(h, p))) continue;
    out.push({
      countryCode: p.countryCode.toUpperCase(),
      partyId: p.partyId.toUpperCase(),
      status: "offered",
      source: "credentials",
      ...(r.business_details.name && {
        name: r.business_details.name.slice(0, 100),
      }),
    });
  }
  return out;
}

/** How often editHubParties re-reads after someone else changed the peer. */
const EDIT_TRIES = 5;

/**
 * Changes a peer's hub party list without losing a concurrent change: reads the peer,
 * applies `edit` to its current list, and writes only if nobody changed the peer in
 * between (compare-and-set on updatedAt); otherwise reads again. `edit` returns null to
 * leave the peer as it is. Returns the updated peer, or null if the peer is gone, not
 * registered (with `ifStatus`), or kept changing.
 */
export async function editHubParties<T>(
  store: PeerStore,
  peerId: string,
  edit: (peer: Peer) => { hubParties: HubParty[]; result: T } | null,
  ifStatus?: Peer["status"],
): Promise<{ peer: Peer; result: T } | null> {
  for (let i = 0; i < EDIT_TRIES; i++) {
    const peer = await store.getPeer(peerId);
    if (!peer || (ifStatus && peer.status !== ifStatus)) return null;
    const next = edit(peer);
    if (!next) return null;
    const updated = await store.updatePeer(
      peerId,
      { hubParties: next.hubParties },
      ifStatus,
      peer.updatedAt,
    );
    if (updated) return { peer: updated, result: next.result };
  }
  return null;
}
