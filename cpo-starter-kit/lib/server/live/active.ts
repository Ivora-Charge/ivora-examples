import "server-only";
import { IvoraError } from "../ivora/errors";
import type { IvoraClient, Transaction } from "../ivora/types";
import { scanNewTransactions } from "./transactions";
import type { LiveStore, TrackedSession } from "./types";

/**
 * The sessions that are running now. Ivora's `GET /transactions` lists sessions oldest
 * first with no date or active filter, and its items carry no ID token or connector, so
 * "the first 100" are the oldest, not the current ones. The kit keeps its own small
 * table of sessions (cpo_active_sessions) instead and fills it from:
 *
 *  1. webhooks (charging_session.status_changed, meter.sampled, connector events):
 *     the event names a transaction, which is read with `GET /transactions/{id}`;
 *  2. its own stop commands and free checkouts, which read the session they act on;
 *  3. a scan of each station's list from a stored high-water mark (cpo_active_marks):
 *     the fallback when webhooks are off, late or lost, and the cold-start rebuild.
 *     It reads only items not known to have ended, never pages from 0 twice, and
 *     seeds the mark on a long history (see transactions.ts).
 *
 * A tracked session is re-read once it has gone REFRESH_AFTER_MS without news, so a
 * missed "ended" webhook is repaired. An ended session is final in the table.
 */

/** A station is scanned at most this often per server instance. */
export const SYNC_INTERVAL_MS = 30_000;
/** Stations scanned per Live load; the rest follow on the next loads. */
export const SYNC_MAX_STATIONS = 10;
/** A tracked session with no news for this long is read again. */
export const REFRESH_AFTER_MS = 2 * 60_000;
/** Tracked sessions read again per load. */
export const REFRESH_MAX = 10;

export interface ActiveDeps {
  store: Pick<
    LiveStore,
    | "listTrackedSessions"
    | "trackSession"
    | "getTrackerMark"
    | "advanceTrackerMark"
  >;
  ivora: Pick<
    IvoraClient,
    "getTransaction" | "listTransactionsAfter" | "listTransactions"
  > &
    Partial<Pick<IvoraClient, "mode">>;
  now?: () => number;
}

const nowOf = (d: { now?: () => number }) => (d.now ?? Date.now)();

/** When each station was last scanned by this server instance (a throttle only). */
const scanned = new Map<number, number>();

/** Tests: forget the throttle. */
export function resetActiveSyncForTests() {
  scanned.clear();
}

/** A session that may be running: active, or not known to have ended. */
const running = (t: Transaction) =>
  t.active === true || (t.active === null && !t.ended_at);

/** Records a session as read from Ivora. Sessions without a station are ignored. */
export async function trackTransaction(
  d: { store: Pick<LiveStore, "trackSession"> },
  tx: Transaction,
): Promise<void> {
  if (tx.station_id == null) return;
  await d.store.trackSession({
    transactionId: tx.id,
    stationId: tx.station_id,
    connectorId: tx.connector_id,
    connectorNumber: tx.connector_number ?? null,
    idToken: tx.id_token ?? null,
    startedAt: tx.started_at,
    endedAt: tx.ended_at,
    energyWh: tx.energy_wh ?? null,
    active: running(tx),
  });
}

/**
 * Reads a transaction (a webhook or a command named it) and records it. A 404 is not
 * an error: the event may name something that is not a session.
 */
export async function trackTransactionById(
  d: ActiveDeps,
  transactionId: number,
): Promise<void> {
  try {
    await trackTransaction(d, await d.ivora.getTransaction(transactionId));
  } catch (e) {
    if (!(e instanceof IvoraError && e.status === 404)) throw e;
  }
}

export interface ActiveSync {
  /** The running sessions of the stations asked for. */
  sessions: TrackedSession[];
  /** Ended sessions seen in the last day, newest first (for a station page). */
  ended: TrackedSession[];
  /** False when a scan or a read failed or ran out of budget: the list may lag. */
  complete: boolean;
}

/**
 * Brings the tracked sessions of these stations up to date and returns them. Scans
 * each station from its mark (throttled, and at most SYNC_MAX_STATIONS per call) and
 * re-reads tracked sessions that have had no news. With `fresh`, every tracked session
 * of these stations is re-read and the throttle ignored: commands that act on a
 * session or connector decide on that. A failed Ivora call degrades to the tracked
 * state with `complete` false; it does not fail the page.
 */
export async function syncActiveSessions(
  d: ActiveDeps,
  stationIds: number[],
  o: { fresh?: boolean } = {},
): Promise<ActiveSync> {
  const now = nowOf(d);
  const wanted = new Set(stationIds);
  // The demo client simulates a small fleet with no history, so there is nothing to
  // track: its list is the current state.
  if (d.ivora.mode === "demo") {
    const list = await d.ivora.listTransactions({ limit: 100 });
    return {
      sessions: list
        .filter((t) => running(t) && wanted.has(t.station_id ?? 0))
        .map(toTracked(now)),
      ended: list
        .filter((t) => !running(t) && wanted.has(t.station_id ?? 0))
        .map(toTracked(now)),
      complete: true,
    };
  }
  let complete = true;
  const fail = (e: unknown) => {
    if (!(e instanceof IvoraError)) throw e;
    complete = false;
    console.error("cpo-starter-kit: session tracking:", {
      status: e.status,
      code: e.code,
    });
  };

  // 1. Scan for sessions the kit has not seen.
  const due = stationIds
    .filter((id) => o.fresh || now - (scanned.get(id) ?? 0) >= SYNC_INTERVAL_MS)
    .sort((a, b) => (scanned.get(a) ?? 0) - (scanned.get(b) ?? 0));
  if (due.length > SYNC_MAX_STATIONS && !o.fresh) complete = false;
  // Sessions read in full during this call; the refresh below skips them.
  const readNow = new Set<number>();
  const known = new Map(
    (await d.store.listTrackedSessions({ ended: true })).map((t) => [
      t.transactionId,
      t,
    ]),
  );
  for (const id of o.fresh ? due : due.slice(0, SYNC_MAX_STATIONS)) {
    scanned.set(id, now);
    try {
      const r = await scanNewTransactions(
        {
          ivora: d.ivora,
          marks: {
            getTransactionMark: (s) => d.store.getTrackerMark(s),
            advanceTransactionMark: (s, t) => d.store.advanceTrackerMark(s, t),
          },
          now: d.now,
        },
        id,
        {
          // Not known to have ended, and not already tracked: a tracked session is
          // kept current by the refresh below.
          include: (item) => item.active !== false && !known.has(item.id),
          offer: async (tx) => {
            readNow.add(tx.id);
            await trackTransaction(d, tx);
          },
        },
      );
      if (!r.complete) complete = false;
    } catch (e) {
      fail(e);
    }
  }

  // 2. Re-read tracked sessions with no news.
  const stale = (await d.store.listTrackedSessions())
    .filter(
      (t) =>
        wanted.has(t.stationId) &&
        !readNow.has(t.transactionId) &&
        (o.fresh || now - Date.parse(t.checkedAt) >= REFRESH_AFTER_MS),
    )
    .sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt));
  for (const t of o.fresh ? stale : stale.slice(0, REFRESH_MAX)) {
    try {
      await trackTransactionById(d, t.transactionId);
    } catch (e) {
      fail(e);
    }
  }
  if (!o.fresh && stale.length > REFRESH_MAX) complete = false;

  const all = (await d.store.listTrackedSessions({ ended: true })).filter((t) =>
    wanted.has(t.stationId),
  );
  return {
    sessions: all.filter((t) => t.active),
    ended: all.filter((t) => !t.active),
    complete,
  };
}

/** A tracked session in the shape the Live rules read (`Transaction`). */
export function asTransaction(t: TrackedSession): Transaction {
  return {
    id: t.transactionId,
    station_id: t.stationId,
    connector_id: t.connectorId,
    connector_number: t.connectorNumber,
    active: t.active,
    id_token: t.idToken,
    started_at: t.startedAt,
    ended_at: t.endedAt,
    energy_wh: t.energyWh,
  };
}

const toTracked =
  (now: number) =>
  (t: Transaction): TrackedSession => ({
    transactionId: t.id,
    stationId: t.station_id ?? 0,
    connectorId: t.connector_id,
    connectorNumber: t.connector_number ?? null,
    idToken: t.id_token ?? null,
    startedAt: t.started_at,
    endedAt: t.ended_at,
    energyWh: t.energy_wh ?? null,
    active: running(t),
    checkedAt: new Date(now).toISOString(),
  });
