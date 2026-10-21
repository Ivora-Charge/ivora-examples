import "server-only";
import { randomUUID } from "node:crypto";
import { ocpiPages, type ClientOptions } from "@/lib/ocpi/client";
import { OcpiError } from "@/lib/ocpi/errors";
import { ourParty } from "@/lib/ocpi/identity";
import { parseLocation, sameId } from "@/lib/ocpi/locations";
import type { Peer, PeerStore } from "@/lib/ocpi/store";
import { parseTariff } from "@/lib/ocpi/tariffs";
import { decryptToken } from "@/lib/ocpi/tokens";
import { ocpiTimestamp } from "@/lib/ocpi/types";
import { assertLive } from "@/lib/server/demo";
import type {
  LocationStore,
  SyncMode,
  SyncModule,
  SyncResult,
  SyncRun,
  SyncState,
} from "./store";

/**
 * Pulls a peer's locations or tariffs from its Sender interface (OCPI 2.2.1 sections
 * 8.2.1 and 11.2.1).
 *
 * - The first pull is full. Later pulls are incremental: `date_from` is when the last
 *   completed pull started, minus CLOCK_SKEW_MS for the difference between our clock and
 *   the CPO's.
 * - Pages follow the Link header. After every page the next page's URL is saved, so a
 *   pull that stops (a timeout, a deployment, `maxPages`) resumes there next time.
 * - One pull per peer and module at a time: a run claims the state with its own ID, and
 *   a run whose heartbeat is older than STALE_RUN_MS counts as interrupted.
 * - A full pull that completes removes the peer's objects it did not see (and that no
 *   push touched meanwhile).
 * - Every object is validated; invalid ones, and ones of another party than the peer's,
 *   are skipped and counted, not stored. A pulled object older than the one we hold
 *   (a push got there first) only counts as seen.
 */

export const CLOCK_SKEW_MS = 5 * 60 * 1000;
export const STALE_RUN_MS = 5 * 60 * 1000;
/** Pages per call. A larger peer takes several calls, each resuming the last. */
export const DEFAULT_MAX_PAGES = 50;
/** Objects per page we ask for. The peer may return fewer (X-Limit). */
export const PAGE_LIMIT = 100;

export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncError";
  }
}

export type SyncDeps = {
  peers: PeerStore;
  locations: LocationStore;
  client?: ClientOptions;
  now?: () => Date;
};

export type SyncOptions = {
  /** "auto": full the first time, then incremental. Default "auto". */
  mode?: "auto" | SyncMode;
  maxPages?: number;
};

export type SyncReport = {
  peerId: string;
  module: SyncModule;
  mode: SyncMode;
  /** False when the pull stopped at maxPages; the next call resumes it. */
  complete: boolean;
  resumed: boolean;
  pages: number;
  items: number;
  invalid: number;
  removed: number;
};

function senderEndpoint(peer: Peer, module: SyncModule): string {
  const url = peer.endpoints.find(
    (e) => e.identifier === module && e.role === "SENDER",
  )?.url;
  if (!url)
    throw new SyncError(`${peer.label} has no ${module} Sender endpoint`);
  return url;
}

const message = (e: unknown) =>
  e instanceof SyncError || e instanceof OcpiError
    ? e.message
    : e instanceof Error && "code" in e && e.code === "demo_mode"
      ? e.message
      : "unexpected error";

const ofPeer = (peer: Peer, o: { country_code: string; party_id: string }) =>
  peer.roles.some(
    (r) =>
      sameId(r.country_code, o.country_code) && sameId(r.party_id, o.party_id),
  );

/**
 * Validates and stores one page. Returns how many objects were stored and how many
 * were skipped as invalid or not of this peer's parties. The store keeps an object it
 * holds with a newer last_updated (a push got there first), even one pushed while this
 * page is being stored.
 */
async function storePage(
  store: LocationStore,
  peer: Peer,
  module: SyncModule,
  raw: unknown[],
  seenAt: string,
): Promise<{ items: number; invalid: number }> {
  if (module === "locations") {
    const pulled = raw
      .map((x) => parseLocation(x))
      .flatMap((p) => (p.ok && ofPeer(peer, p.value) ? [p.value] : []));
    await store.saveLocations(peer.id, pulled, seenAt);
    return { items: pulled.length, invalid: raw.length - pulled.length };
  }
  const pulled = raw
    .map((x) => parseTariff(x))
    .flatMap((p) => (p.ok && ofPeer(peer, p.value) ? [p.value] : []));
  await store.saveTariffs(peer.id, pulled, seenAt);
  return { items: pulled.length, invalid: raw.length - pulled.length };
}

/** Pulls one module of one peer. Refused in demo mode. */
export async function syncPeer(
  peerId: string,
  module: SyncModule,
  deps: SyncDeps,
  options: SyncOptions = {},
): Promise<SyncReport> {
  assertLive(`pull ${module} from a CPO`);
  const now = deps.now ?? (() => new Date());
  const store = deps.locations;
  const peer = await deps.peers.getPeer(peerId);
  if (!peer) throw new SyncError("No such peer");
  if (peer.status !== "registered" || !peer.tokenCiphertext)
    throw new SyncError(`${peer.label} is ${peer.status}, not registered`);
  const endpoint = senderEndpoint(peer, module);
  const token = decryptToken(peer.tokenCiphertext, peer.id);
  const cpo = peer.roles.find((r) => r.role === "CPO") ?? peer.roles[0];

  const held: SyncState = (await store.getSyncState(peerId, module)) ?? {
    peerId,
    module,
    lastFullSyncAt: null,
    cursor: null,
    run: null,
    lastResult: null,
  };
  const busy = () =>
    new SyncError(`A ${module} pull from ${peer.label} is already running`);
  const t0 = now();
  if (
    held.run &&
    t0.getTime() - Date.parse(held.run.heartbeatAt) < STALE_RUN_MS
  )
    throw busy();

  const wanted = options.mode ?? "auto";
  const mode: SyncMode =
    wanted !== "auto"
      ? wanted
      : held.lastFullSyncAt && held.cursor
        ? "incremental"
        : "full";
  // Resume an interrupted run of the same kind, if its next page is still on the
  // peer's endpoint origin; anything else starts afresh.
  const resumable =
    !!held.run &&
    held.run.mode === mode &&
    (!held.run.nextUrl ||
      new URL(held.run.nextUrl).origin === new URL(endpoint).origin);
  const run: SyncRun =
    resumable && held.run
      ? { ...held.run, id: randomUUID(), heartbeatAt: t0.toISOString() }
      : {
          id: randomUUID(),
          mode,
          startedAt: t0.toISOString(),
          dateFrom:
            mode === "incremental" && held.cursor
              ? ocpiTimestamp(new Date(Date.parse(held.cursor) - CLOCK_SKEW_MS))
              : null,
          nextUrl: null,
          pages: 0,
          items: 0,
          invalid: 0,
          heartbeatAt: t0.toISOString(),
        };
  let state: SyncState = { ...held, run };
  if (!(await store.saveSyncState(state, held.run?.id ?? null))) throw busy();

  /** Saves the state while this run still owns it. */
  const save = async (next: SyncState) => {
    if (!(await store.saveSyncState(next, state.run?.id ?? null)))
      throw new SyncError(
        `Another ${module} pull from ${peer.label} took over`,
      );
    state = next;
  };
  const report = (complete: boolean, r: SyncRun, removed = 0): SyncReport => ({
    peerId,
    module,
    mode: r.mode,
    complete,
    resumed: resumable,
    pages: r.pages,
    items: r.items,
    invalid: r.invalid,
    removed,
  });
  /** A run nobody is working on: the next call resumes it at once. */
  const parked = (r: SyncRun): SyncRun => ({
    ...r,
    heartbeatAt: new Date(0).toISOString(),
  });

  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
  let pagesThisCall = 0;
  try {
    const pages = ocpiPages(
      {
        url: run.nextUrl ?? endpoint,
        token,
        // A saved next link carries its own offset, limit and date filters.
        limit: run.nextUrl ? undefined : PAGE_LIMIT,
        dateFrom: run.nextUrl ? undefined : (run.dateFrom ?? undefined),
        routing: {
          from: ourParty(),
          to: { countryCode: cpo.country_code, partyId: cpo.party_id },
        },
      },
      deps.client,
    );
    for await (const page of pages) {
      const counts = await storePage(
        store,
        peer,
        module,
        page.items,
        now().toISOString(),
      );
      pagesThisCall++;
      const r = state.run!;
      const next: SyncRun = {
        ...r,
        nextUrl: page.next ?? null,
        pages: r.pages + 1,
        items: r.items + counts.items,
        invalid: r.invalid + counts.invalid,
        heartbeatAt: now().toISOString(),
      };
      if (page.next && pagesThisCall >= maxPages) {
        await save({ ...state, run: parked(next) });
        return report(false, next);
      }
      await save({ ...state, run: next });
    }

    const r = state.run!;
    const removed =
      r.mode !== "full"
        ? 0
        : module === "locations"
          ? await store.pruneLocations(peerId, r.startedAt)
          : await store.pruneTariffs(peerId, r.startedAt);
    const result: SyncResult = {
      ok: true,
      mode: r.mode,
      finishedAt: now().toISOString(),
      items: r.items,
      invalid: r.invalid,
      removed,
    };
    await save({
      ...state,
      lastFullSyncAt: r.mode === "full" ? r.startedAt : state.lastFullSyncAt,
      cursor: r.startedAt,
      run: null,
      lastResult: result,
    });
    return report(true, r, removed);
  } catch (e) {
    const error = message(e);
    // Keep the run, parked, so the next call resumes at the page that failed.
    const r = state.run;
    if (r)
      await store
        .saveSyncState(
          {
            ...state,
            run: parked(r),
            lastResult: {
              ok: false,
              mode: r.mode,
              finishedAt: now().toISOString(),
              items: r.items,
              invalid: r.invalid,
              removed: 0,
              error,
            },
          },
          r.id,
        )
        .catch(() => undefined);
    throw e instanceof SyncError
      ? e
      : new SyncError(`Pulling ${module} from ${peer.label} failed: ${error}`);
  }
}

export type PeerSyncOutcome = {
  peerId: string;
  module: SyncModule;
  ok: boolean;
  complete?: boolean;
  items?: number;
  invalid?: number;
  removed?: number;
  /** Safe to show: no tokens. */
  error?: string;
};

/**
 * One round of pulls for every registered peer: tariffs first, so prices are there when
 * the locations arrive, then locations. A peer without a Sender endpoint for a module
 * is skipped; one peer's failure does not stop the others.
 */
export async function syncAllPeers(
  deps: SyncDeps,
  options: SyncOptions = {},
): Promise<PeerSyncOutcome[]> {
  assertLive("pull locations and tariffs from CPOs");
  const out: PeerSyncOutcome[] = [];
  for (const peer of await deps.peers.listPeers()) {
    if (peer.status !== "registered") continue;
    for (const module of ["tariffs", "locations"] as const) {
      if (
        !peer.endpoints.some(
          (e) => e.identifier === module && e.role === "SENDER",
        )
      )
        continue;
      try {
        const r = await syncPeer(peer.id, module, deps, options);
        out.push({
          peerId: peer.id,
          module,
          ok: true,
          complete: r.complete,
          items: r.items,
          invalid: r.invalid,
          removed: r.removed,
        });
      } catch (e) {
        out.push({ peerId: peer.id, module, ok: false, error: message(e) });
      }
    }
  }
  return out;
}
