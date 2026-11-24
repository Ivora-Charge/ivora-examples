import "server-only";
import { randomUUID } from "node:crypto";
import { assertLive } from "@/lib/server/demo";
import { logText } from "@/lib/server/log-error";
import { ABSENT_CODES, DatabaseRequestError } from "@/lib/server/supabase-rest";
import { tokensReceiver } from "@/lib/tokens/push";
import type { TokenStore } from "@/lib/tokens/store";
import { ocpiPages, type ClientOptions } from "./client";
import { OcpiError } from "./errors";
import { HandshakeError } from "./handshake";
import { ourParty } from "./identity";
import {
  capOffered,
  editHubParties,
  isHubPeer,
  isPartyOfPeer,
  MAX_OFFERED,
} from "./parties";
import type { HubParty, HubPushMode, Peer, PeerStore } from "./store";
import { decryptToken } from "./tokens";
import { sameParty, type Party } from "./types";

/**
 * The CPO parties behind a roaming hub peer, and who decides which of them we trust.
 *
 * A hub's credentials name the hub itself (role HUB). The CPOs it connects us to come
 * from the operator: `acceptParty` adds a party as trusted. The hub's own client list
 * (the hubclientinfo module, OCPI 2.2.1 section 7) can offer parties (`offerFromHub`),
 * but an offered party is not trusted: we pull nothing from it, send it no command and
 * accept nothing from it until the operator accepts it. Party IDs are never built in:
 * they come from the operator or from the hub's list.
 *
 * Token pushes depend on the hub's push mode (`setHubPushMode`). With `per_party` each
 * trusted party gets its own push. With `hub` one push goes to the hub's own party and
 * the hub decides who receives it; the trusted list then limits only pulls, commands
 * and what we accept.
 */

export type HubDeps = {
  store: PeerStore;
  client?: ClientOptions;
  actor?: string;
  /** The clock, for tests. */
  now?: () => Date;
};

const COUNTRY = /^[A-Za-z]{2}$/;
const PARTY_ID = /^[A-Za-z0-9]{3}$/;

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
  // Another peer's party: a direct peer's role, another hub's HUB role or a party it
  // trusts. A CPO role another hub merely declares is only an offer and does not count.
  for (const other of await store.listPeers()) {
    if (other.id === hub.id || other.status !== "registered") continue;
    if (!isPartyOfPeer(other, party)) continue;
    return isHubPeer(other) &&
      !other.roles.some(
        (r) =>
          r.role === "HUB" &&
          sameParty(
            { countryCode: r.country_code, partyId: r.party_id },
            party,
          ),
      )
      ? `${idOf(party)} is already trusted through ${other.label}`
      : `${idOf(party)} is already registered as ${other.label}`;
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
  const done = await editHubParties(
    deps.store,
    peerId,
    (current) => {
      const held = current.hubParties.find((h) => sameParty(h, party));
      const next: HubParty = {
        ...party,
        status: "trusted",
        source: held?.source ?? "admin",
        ...((name ?? held?.name) && { name: name ?? held?.name }),
        // Accepting a trusted party again does not restart its "trusted since".
        ...(held?.status === "trusted"
          ? held.trustedAt && { trustedAt: held.trustedAt }
          : { trustedAt: (deps.now?.() ?? new Date()).toISOString() }),
      };
      return {
        hubParties: [
          ...current.hubParties.filter((h) => !sameParty(h, party)),
          next,
        ],
        result: held,
      };
    },
    "registered",
  );
  if (!done) throw new HandshakeError("The peer changed; try again");
  const { peer: updated, result: held } = done;
  // conflict() read the other peers before the write: look again now. Another peer
  // that claimed the party meanwhile makes this accept back out (the other peer does
  // the same on its side), so the two cannot both stay.
  const lost = await conflict(deps.store, peer, party);
  if (lost) {
    await editHubParties(deps.store, peerId, (current) => ({
      hubParties: [
        ...current.hubParties.filter((h) => !sameParty(h, party)),
        ...(held ? [held] : []),
      ],
      result: null,
    }));
    throw new HandshakeError(lost);
  }
  await deps.store.audit({
    actor: deps.actor ?? "admin",
    action: "ocpi.hub.party_trusted",
    subjectId: peerId,
    details: { party: idOf(party), offered: held?.status === "offered" },
  });
  // A trusted party's pushes are no longer refused: drop its refusal row, so it does
  // not count toward the hub's cap. Best effort: the table is missing before its
  // migration, and the accept stands either way.
  try {
    await deps.store.forgetRefusal(peerId, party);
  } catch (e) {
    if (!(
      e instanceof DatabaseRequestError &&
      e.code !== null &&
      ABSENT_CODES.has(e.code)
    ))
      console.error(
        `Forgetting the refused pushes of ${idOf(party)} at peer ${peerId} failed: ${logText(e)}`,
      );
  }
  return updated;
}

/**
 * The operator stops trusting a party (or dismisses an offered one): it is removed from
 * the list, so it is no longer pulled from or sent commands (nor tokens, in per-party
 * mode), and its pushes are refused at once. `purge`
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
  if (!peer.hubParties.some((h) => sameParty(h, party)))
    throw new HandshakeError(`${idOf(party)} is not in the list`);
  const done = await editHubParties(deps.store, peerId, (current) => {
    const held = current.hubParties.find((h) => sameParty(h, party));
    if (!held) return null;
    return {
      hubParties: current.hubParties.filter((h) => !sameParty(h, party)),
      result: held,
    };
  });
  if (!done) throw new HandshakeError("The peer changed; try again");
  const { peer: updated, result: held } = done;
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
 * ones are `offered`; trusted ones stay trusted; offered ones the list no longer has
 * are dropped (offers from the hub's credentials stay). Never changes trust. Returns
 * the peer and how many parties are newly offered. Refused in demo mode.
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
  // The fetch can take a while, and the operator may accept or remove parties in the
  // meantime: merge into the list as it is now, not as it was before the fetch, and
  // write only if it did not change since (editHubParties). Offers never change trust.
  const done = await editHubParties(
    deps.store,
    peerId,
    (current) => {
      const trusted = current.hubParties.filter((h) => h.status === "trusted");
      const known = current.hubParties.filter((h) => h.status === "offered");
      const offers: HubParty[] = [];
      let offered = 0;
      for (const { party } of listed.slice(0, MAX_OFFERED)) {
        if (
          trusted.some((h) => sameParty(h, party)) ||
          offers.some((h) => sameParty(h, party)) ||
          sameParty(party, ourParty())
        )
          continue;
        const held = known.find((h) => sameParty(h, party));
        if (!held) offered++;
        offers.push(
          held ?? { ...party, status: "offered", source: "hubclientinfo" },
        );
      }
      // Offers from elsewhere (the hub's own credentials) stay; earlier client-list
      // offers the hub no longer lists go.
      const kept = known.filter(
        (h) =>
          h.source !== "hubclientinfo" && !offers.some((o) => sameParty(o, h)),
      );
      return {
        hubParties: capOffered([...trusted, ...kept, ...offers]),
        result: offered,
      };
    },
    "registered",
  );
  if (!done) throw new HandshakeError("The peer changed; try again");
  const { peer: updated, result: offered } = done;
  await deps.store.audit({
    actor: deps.actor ?? "admin",
    action: "ocpi.hub.parties_offered",
    subjectId: peerId,
    details: { listed: listed.length, newlyOffered: offered },
  });
  return { peer: updated, offered };
}

/**
 * How token pushes to a hub are addressed: to the hub's own party (`hub`) or to each
 * trusted party behind it (`per_party`). Pushes already owed are sent the new way on
 * their next try.
 *
 * Switching from `per_party` to `hub` owes the hub every active token through the
 * outbox (the catch-up), so the hub gets the full set once; the retry job sends them,
 * and later changes go out as usual. Switching back needs no catch-up: the trusted
 * parties got every change through the hub. If the catch-up cannot be queued, the mode
 * is set back and the error thrown, so trying again owes the set once, not twice.
 */
export async function setHubPushMode(
  peerId: string,
  mode: HubPushMode,
  deps: HubDeps & { tokens: Pick<TokenStore, "oweActive">; now?: () => Date },
): Promise<{ peer: Peer; owed: number; changed: boolean }> {
  if (mode !== "hub" && mode !== "per_party")
    throw new HandshakeError("Push mode must be hub or per_party");
  const peer = await hubPeer(deps.store, peerId);
  const from = peer.hubPushMode;
  if (from === mode) return { peer, owed: 0, changed: false };
  const updated = await deps.store.updatePeer(
    peerId,
    { hubPushMode: mode },
    "registered",
    peer.rev,
  );
  if (!updated) throw new HandshakeError("The peer changed; try again");
  let owed = 0;
  if (mode === "hub" && updated.tokenCiphertext && tokensReceiver(updated)) {
    try {
      owed = await deps.tokens.oweActive(
        peerId,
        (deps.now?.() ?? new Date()).toISOString(),
      );
    } catch {
      await deps.store
        .updatePeer(peerId, { hubPushMode: from }, "registered", updated.rev)
        .catch(() => null);
      throw new HandshakeError(
        "Could not queue the hub's tokens; the mode is unchanged, try again",
      );
    }
  }
  await deps.store.audit({
    actor: deps.actor ?? "admin",
    action: "ocpi.hub.push_mode_set",
    subjectId: peerId,
    details: { mode, from, owed },
  });
  return { peer: updated, owed, changed: true };
}
