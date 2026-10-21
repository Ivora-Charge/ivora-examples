import "server-only";
import {
  pullModule,
  SyncError,
  type PeerSyncOutcome,
  type PullTarget,
  type SyncOptions,
  type SyncReport,
  type SyncStateStore,
} from "@/lib/locations/sync";
import type { ClientOptions } from "@/lib/ocpi/client";
import { OcpiError } from "@/lib/ocpi/errors";
import { sameId } from "@/lib/ocpi/locations";
import {
  parseCdr,
  parseSession,
  type Cdr,
  type Session,
} from "@/lib/ocpi/session-objects";
import type { Peer } from "@/lib/ocpi/store";
import { assertLive } from "@/lib/server/demo";
import { recordCdr, recordSession, type SessionDeps } from "./record";

/**
 * Pulls sessions and CDRs from each CPO's Sender interface (OCPI 2.2.1 sections 9.2.1
 * and 10.2.1), for CPOs that do not push them, and to catch pushes that never arrived.
 * Every registered peer with a Sender is pulled; what was pushed already changes
 * nothing (record.ts).
 *
 * It is the locations pull (lib/locations/sync.ts), with its state in the same table:
 * paginated by the Link header, resumable at the page it stopped at, one pull per peer
 * and module at a time. The first pull starts when the peer was added (minus 5 minutes
 * for clock differences): there are no sessions of our tokens before that, and the
 * Sessions Sender needs a `date_from`. Later pulls ask for changes since the last one
 * started. Nothing is ever removed.
 *
 * Invalid objects, and objects of a party that is not one of the peer's CPO parties,
 * are skipped and counted, never stored.
 */
export type SessionPullDeps = SessionDeps & {
  syncState: SyncStateStore;
  client?: ClientOptions;
};

export type SessionModule = "sessions" | "cdrs";

const ofCpoParty = (
  peer: Peer,
  o: { country_code: string; party_id: string },
) =>
  peer.roles.some(
    (r) =>
      r.role === "CPO" &&
      sameId(r.country_code, o.country_code) &&
      sameId(r.party_id, o.party_id),
  );

function target(module: SessionModule, deps: SessionPullDeps): PullTarget {
  return {
    module,
    since: (peer) => peer.createdAt,
    async storePage(peer, raw) {
      let items = 0;
      // One by one, in order: a session and its changes on one page land in order.
      for (const x of raw) {
        const parsed = module === "sessions" ? parseSession(x) : parseCdr(x);
        if (!parsed.ok || !ofCpoParty(peer, parsed.value)) continue;
        if (module === "sessions")
          await recordSession(peer, parsed.value as Session, deps);
        else await recordCdr(peer, parsed.value as Cdr, "pull", deps);
        items++;
      }
      return { items, invalid: raw.length - items };
    },
  };
}

/** Pulls one peer's sessions or CDRs. Refused in demo mode. */
export function pullSessions(
  peerId: string,
  module: SessionModule,
  deps: SessionPullDeps,
  options: SyncOptions = {},
): Promise<SyncReport> {
  return pullModule(
    peerId,
    target(module, deps),
    {
      peers: deps.peers,
      syncState: deps.syncState,
      client: deps.client,
      now: deps.now,
    },
    options,
  );
}

/**
 * One round of pulls for every registered peer: sessions, then CDRs. A peer without a
 * Sender for a module is skipped; one peer's failure does not stop the others.
 */
export async function pullAllSessions(
  deps: SessionPullDeps,
  options: SyncOptions = {},
): Promise<PeerSyncOutcome[]> {
  assertLive("pull sessions and CDRs from CPOs");
  const out: PeerSyncOutcome[] = [];
  for (const peer of await deps.peers.listPeers()) {
    if (peer.status !== "registered") continue;
    for (const module of ["sessions", "cdrs"] as const) {
      if (
        !peer.endpoints.some(
          (e) => e.identifier === module && e.role === "SENDER",
        )
      )
        continue;
      try {
        const r = await pullSessions(peer.id, module, deps, options);
        out.push({
          peerId: peer.id,
          module,
          ok: true,
          complete: r.complete,
          items: r.items,
          invalid: r.invalid,
        });
      } catch (e) {
        out.push({
          peerId: peer.id,
          module,
          ok: false,
          error:
            e instanceof SyncError || e instanceof OcpiError
              ? e.message
              : "unexpected error",
        });
      }
    }
  }
  return out;
}
