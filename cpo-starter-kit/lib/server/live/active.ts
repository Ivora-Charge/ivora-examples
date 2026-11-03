import "server-only";
import { IvoraError } from "../ivora/errors";
import type {
  CursorPage,
  IvoraClient,
  ReadLimits,
  SessionListItem,
  SessionQuery,
  Transaction,
} from "../ivora/types";
import type { LiveStore, TrackedSession } from "./types";

/**
 * The sessions that are running now. Ivora's `GET /transactions` filters by `active`
 * and lists newest first (IVP-436), with the masked ID token, connector, station name
 * and bill ID in each item, so "the running sessions" are one list read. The kit keeps
 * them in a small table (cpo_active_sessions) all the same, as the cache every Live
 * view reads, and fills it from:
 *
 *  1. the list `active=true`, newest first, read at most every SYNC_INTERVAL_MS per
 *     charger (cpo_active_marks keeps when): the way new sessions are found, with no
 *     webhooks needed;
 *  2. webhooks (charging_session.status_changed, meter.sampled, connector events): the
 *     event names a transaction, which is read with `GET /transactions/{id}`, so a
 *     change shows before the next list read;
 *  3. its own stop commands and free checkouts, which read the session they act on.
 *
 * After a complete list read, a tracked session the list does not show has ended and
 * is read once to record it. An ended session is final in the table. All of it runs
 * within one budget per page load (SYNC_BUDGET_MS, SYNC_MAX_CALLS), and the first 429
 * stops it: what is left carries on with the next load.
 */

/**
 * A station is scanned at most this often (its mark's scanned_at, so across server
 * instances).
 */
export const SYNC_INTERVAL_MS = 30_000;
/** Items per page of the running-session list, and pages read per load. */
export const LIST_PAGE_SIZE = 100;
export const LIST_MAX_PAGES = 5;
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
    | "getTrackerSeed"
    | "saveTrackerSeed"
  >;
  ivora: Pick<
    IvoraClient,
    "getTransaction" | "listSessions" | "listTransactions"
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
/**
 * A time Postgres reads back the same: written as UTC ISO 8601 with a 4-digit year.
 * JavaScript also parses extended years ("+010000-01-01"), which Postgres rejects.
 */
const time = (v: unknown) => {
  if (typeof v !== "string" || v.length > 40) return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return null;
  const year = new Date(ms).getUTCFullYear();
  return year >= 1 && year <= 9999 ? new Date(ms).toISOString() : null;
};

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
    listSessions: (q: SessionQuery) => call((l) => d.ivora.listSessions(q, l)),
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

  // 1. List the running sessions (`active=true`, newest first): one request per page of
  // 100 for the whole project, whatever the history. Each item carries the masked ID
  // token and the connector, so it is recorded as it is, with no read per session. The
  // throttle is per charger (its mark's scanned_at, so across server instances).
  const lastScan = (id: number) => {
    const at = marks.get(id)?.scannedAt;
    return at ? Date.parse(at) : 0;
  };
  const due = stationIds.filter(
    (id) => o.fresh || now - lastScan(id) >= SYNC_INTERVAL_MS,
  );
  // Sessions recorded from the list during this call; the refresh below skips them.
  const readNow = new Set<number>();
  // The list was read to its end: a tracked session missing from it has ended.
  let listed = false;
  if (due.length > 0) {
    const late = due.some((id) => now - lastScan(id) > SCAN_LATE_MS);
    await attempt(async () => {
      let cursor: string | null = null;
      for (let page = 0; page < LIST_MAX_PAGES; page++) {
        const res: CursorPage<SessionListItem> = await ivora.listSessions({
          active: true,
          cursor,
          limit: LIST_PAGE_SIZE,
        });
        for (const item of res.data) {
          readNow.add(item.id);
          if (item.station_id != null && wanted.has(item.station_id))
            await trackTransaction(d, item);
        }
        if (!res.next_cursor || res.data.length < LIST_PAGE_SIZE) {
          listed = true;
          break;
        }
        cursor = res.next_cursor;
      }
      if (!listed) {
        // More running sessions than a load reads: the rest follow with the webhooks
        // and the age-based re-reads below.
        if (late || o.fresh) complete = false;
        return;
      }
      for (const id of due)
        await d.store.advanceTrackerMark(id, 0, { scanned: true });
    }, late);
  }

  // 2. Re-read tracked sessions the list did not show. After a complete list those
  // have ended; otherwise those with no news for a while (stalled ones less often).
  const age = (t: TrackedSession) => now - Date.parse(t.checkedAt);
  const quiet = mine
    .filter(
      (t) =>
        !readNow.has(t.transactionId) &&
        (o.fresh ||
          (listed && due.includes(t.stationId)) ||
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
