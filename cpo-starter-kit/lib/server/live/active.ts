import "server-only";
import { IvoraError } from "../ivora/errors";
import type { IvoraClient, ReadLimits, Transaction } from "../ivora/types";
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
 * missed "ended" webhook is repaired. An ended session is final in the table. All of
 * it runs within one budget per page load (SYNC_BUDGET_MS, SYNC_MAX_CALLS), and the
 * first 429 stops it: what is left carries on with the next load.
 */

/**
 * A station is scanned at most this often (its mark's scanned_at, so across server
 * instances).
 */
export const SYNC_INTERVAL_MS = 30_000;
/** Stations scanned per Live load; the rest follow on the next loads. */
export const SYNC_MAX_STATIONS = 10;
/** A tracked session with no news for this long is read again. */
export const REFRESH_AFTER_MS = 2 * 60_000;
/** Tracked sessions read again per load. */
export const REFRESH_MAX = 10;
/**
 * One sync's whole budget: no Ivora request starts after this long, and none waits
 * past it (the page renders within it, however many stations there are).
 */
export const SYNC_BUDGET_MS = 8_000;
/** Ivora requests per sync (the key's default budget is 180 a minute). */
export const SYNC_MAX_CALLS = 50;
/** Long-history stations seeded per sync (about 20 to 40 requests each). */
export const SEEDS_PER_SYNC = 2;
/**
 * A running session whose energy has not grown for this long, still running when read
 * again, is stalled (as for driver checkouts): shown as such and read less often.
 */
export const STALL_AFTER_MS = 12 * 60 * 60_000;
/** A stalled session is read again this often. */
export const STALLED_REFRESH_AFTER_MS = 30 * 60_000;
/**
 * Work left for a later load only makes the list "may be incomplete" past these: a
 * station not scanned for SCAN_LATE_MS (or never), a session not read for
 * REFRESH_LATE_MS (stalled ones: twice their own interval).
 */
export const SCAN_LATE_MS = 5 * 60_000;
export const REFRESH_LATE_MS = 10 * 60_000;

export interface ActiveDeps {
  store: Pick<
    LiveStore,
    | "listActiveSessions"
    | "trackSession"
    | "forgetSession"
    | "getTrackerMark"
    | "listTrackerMarks"
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

/** A session that may be running: active, or not known to have ended. */
const running = (t: Transaction) =>
  t.active === true || (t.active === null && !t.ended_at);

/** Running, and its energy has not grown for STALL_AFTER_MS when last read. */
export const stalled = (t: TrackedSession) =>
  t.active &&
  Date.parse(t.checkedAt) - Date.parse(t.changedAt) >= STALL_AFTER_MS;

const posInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const time = (v: unknown) =>
  typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v))
    ? v
    : null;

/**
 * Records a session as read from Ivora. Sessions without a station are ignored. A
 * value the table can't hold (a negative energy, an unreadable time, an over-long
 * token) is recorded as unknown, so one odd answer can't fail the write.
 */
export async function trackTransaction(
  d: { store: Pick<LiveStore, "trackSession"> },
  tx: Transaction,
): Promise<void> {
  if (tx.station_id == null) return;
  if (!posInt(tx.id) || !posInt(tx.station_id)) {
    console.error("cpo-starter-kit: skipped an unreadable session", {
      transactionId: tx.id,
    });
    return;
  }
  const energy = tx.energy_wh;
  await d.store.trackSession({
    transactionId: tx.id,
    stationId: tx.station_id,
    connectorId: posInt(tx.connector_id) ? tx.connector_id : null,
    connectorNumber:
      Number.isInteger(tx.connector_number) &&
      tx.connector_number! >= 0 &&
      tx.connector_number! < 2 ** 31
        ? tx.connector_number!
        : null,
    idToken:
      typeof tx.id_token === "string" && tx.id_token.length <= 40
        ? tx.id_token
        : null,
    startedAt: time(tx.started_at),
    endedAt: time(tx.ended_at),
    energyWh:
      typeof energy === "number" && Number.isFinite(energy) && energy >= 0
        ? energy
        : null,
    active: running(tx),
  });
}

/**
 * Reads a transaction (a webhook or a command named it) and records it. A 404 is not
 * an error: the event may name something that is not a session, and a tracked
 * session Ivora no longer knows is dropped.
 */
export async function trackTransactionById(
  d: {
    store: Pick<LiveStore, "trackSession" | "forgetSession">;
    ivora: Pick<IvoraClient, "getTransaction">;
  },
  transactionId: number,
): Promise<void> {
  try {
    await trackTransaction(d, await d.ivora.getTransaction(transactionId));
  } catch (e) {
    if (!(e instanceof IvoraError && e.status === 404)) throw e;
    await d.store.forgetSession(transactionId);
  }
}

export interface ActiveSync {
  /** The running sessions of the stations asked for, newest first. */
  sessions: TrackedSession[];
  /**
   * False when work that matters was cut or failed: a read failed, or a station not
   * scanned for SCAN_LATE_MS or a session not read for REFRESH_LATE_MS was left for
   * later. The list may lag.
   */
  complete: boolean;
  /** Ivora rate-limited the sync: seconds to wait before reading again. */
  retryAfter: number | null;
}

/** Seconds to wait after a 429: Retry-After, at least 10, else a minute. */
export const waitAfter429 = (e: IvoraError) =>
  Math.max(e.retryAfterSeconds ?? 60, 10);

/** Thrown inside a sync when its budget is spent: the work is left for a later load. */
const SPENT = Symbol("budget spent");

/**
 * Brings the tracked sessions of these stations up to date and returns them. Scans
 * the stations due (oldest scan first, at most SYNC_MAX_STATIONS, seeding at most
 * SEEDS_PER_SYNC) and re-reads tracked sessions that have had no news (at most
 * REFRESH_MAX), all within one budget: SYNC_BUDGET_MS and SYNC_MAX_CALLS. The first
 * 429 stops the sync and its Retry-After goes back to the page. With `fresh`, every
 * tracked session of these stations is re-read and the throttle ignored: commands that
 * act on a session or connector decide on that, and refuse when `complete` is false.
 * A failed Ivora call degrades to the tracked state; it does not fail the page.
 */
export async function syncActiveSessions(
  d: ActiveDeps,
  stationIds: number[],
  o: { fresh?: boolean } = {},
): Promise<ActiveSync> {
  const now = nowOf(d);
  const wanted = new Set(stationIds);
  const one = stationIds.length === 1 ? { stationId: stationIds[0] } : {};
  // The demo client simulates a small fleet with no history, so there is nothing to
  // track: its list is the current state.
  if (d.ivora.mode === "demo") {
    const list = await d.ivora.listTransactions({ limit: 100 });
    return {
      sessions: list
        .filter((t) => running(t) && wanted.has(t.station_id ?? 0))
        .map(toTracked(now))
        .sort((a, b) => b.transactionId - a.transactionId),
      complete: true,
      retryAfter: null,
    };
  }

  // The budget. Every Ivora request goes through `call`.
  const deadline = now + SYNC_BUDGET_MS;
  const wallDeadline = Date.now() + SYNC_BUDGET_MS;
  let calls = 0;
  let seeds = 0;
  let retryAfter: number | null = null;
  const call = async <T>(f: (l: ReadLimits) => Promise<T>): Promise<T> => {
    // The client starts no try with less than a second left; neither does the budget.
    if (
      retryAfter !== null ||
      calls >= SYNC_MAX_CALLS ||
      nowOf(d) >= deadline - 1_000
    )
      throw SPENT;
    calls++;
    try {
      return await f({ deadline: wallDeadline, failOn429: true });
    } catch (e) {
      if (e instanceof IvoraError && e.status === 429)
        retryAfter = waitAfter429(e);
      throw e;
    }
  };
  const ivora = {
    listTransactionsAfter: (
      q: Parameters<IvoraClient["listTransactionsAfter"]>[0],
    ) => call((l) => d.ivora.listTransactionsAfter(q, l)),
    getTransaction: (id: number) => call((l) => d.ivora.getTransaction(id, l)),
  };
  let complete = true;
  /** Runs one piece of work; `matters`: leaving it undone makes the list incomplete. */
  const attempt = async (work: () => Promise<void>, matters: boolean) => {
    try {
      await work();
    } catch (e) {
      if (e === SPENT) {
        if (matters || o.fresh) complete = false;
        return;
      }
      if (!(e instanceof IvoraError)) throw e;
      complete = false;
      console.error("cpo-starter-kit: session tracking:", {
        status: e.status,
        code: e.code,
      });
    }
  };

  const [marks, tracked] = await Promise.all([
    d.store.listTrackerMarks(),
    d.store.listActiveSessions(one),
  ]);
  const mine = tracked.filter((t) => wanted.has(t.stationId));
  const knownIds = new Set(mine.map((t) => t.transactionId));

  // 1. Scan for sessions the kit has not seen.
  const lastScan = (id: number) => {
    const at = marks.get(id)?.scannedAt;
    return at ? Date.parse(at) : 0;
  };
  const due = stationIds
    .filter((id) => o.fresh || now - lastScan(id) >= SYNC_INTERVAL_MS)
    .sort((a, b) => lastScan(a) - lastScan(b));
  // Sessions read in full during this call; the refresh below skips them.
  const readNow = new Set<number>();
  for (const [i, id] of due.entries()) {
    const late = now - lastScan(id) > SCAN_LATE_MS;
    if (!o.fresh && i >= SYNC_MAX_STATIONS) {
      if (late) complete = false;
      continue;
    }
    await attempt(async () => {
      const r = await scanNewTransactions(
        {
          ivora,
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
          include: (item) =>
            item.active !== false && !item.ended_at && !knownIds.has(item.id),
          offer: async (tx) => {
            readNow.add(tx.id);
            await trackTransaction(d, tx);
          },
          seed: () => Boolean(o.fresh) || seeds++ < SEEDS_PER_SYNC,
          deadline,
        },
      );
      if (r.complete)
        await d.store.advanceTrackerMark(id, 0, { scanned: true });
      else if (late || o.fresh) complete = false;
    }, late);
  }

  // 2. Re-read tracked sessions with no news (stalled ones less often).
  const age = (t: TrackedSession) => now - Date.parse(t.checkedAt);
  const quiet = mine
    .filter(
      (t) =>
        !readNow.has(t.transactionId) &&
        (o.fresh ||
          age(t) >= (stalled(t) ? STALLED_REFRESH_AFTER_MS : REFRESH_AFTER_MS)),
    )
    .sort((a, b) => age(b) - age(a));
  for (const [i, t] of quiet.entries()) {
    const late =
      age(t) > (stalled(t) ? 2 * STALLED_REFRESH_AFTER_MS : REFRESH_LATE_MS);
    if (!o.fresh && i >= REFRESH_MAX) {
      if (late) complete = false;
      continue;
    }
    await attempt(
      () => trackTransactionById({ store: d.store, ivora }, t.transactionId),
      late,
    );
  }

  const sessions = (await d.store.listActiveSessions(one)).filter((t) =>
    wanted.has(t.stationId),
  );
  return { sessions, complete, retryAfter };
}

/**
 * One page of a station's ended sessions (the last day), newest first, below
 * `before` if set. The demo reads them from its simulated list.
 */
export async function endedSessions(
  d: Pick<ActiveDeps, "ivora" | "now"> & {
    store: Pick<LiveStore, "listEndedSessions">;
  },
  stationId: number,
  o: { before?: number; limit?: number } = {},
): Promise<TrackedSession[]> {
  if (d.ivora.mode === "demo")
    return (await d.ivora.listTransactions({ limit: 100 }))
      .filter(
        (t) =>
          !running(t) &&
          t.station_id === stationId &&
          (o.before === undefined || t.id < o.before),
      )
      .map(toTracked(nowOf(d)))
      .sort((a, b) => b.transactionId - a.transactionId)
      .slice(0, o.limit ?? 20);
  return d.store.listEndedSessions(stationId, o);
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
    changedAt: new Date(now).toISOString(),
  });
