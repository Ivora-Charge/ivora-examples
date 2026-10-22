import "server-only";
import type {
  IvoraClient,
  Transaction,
  TransactionListItem,
} from "../ivora/types";
import type { LiveStore, SeedProgress } from "./types";

/**
 * Finding a new session at a station. On Ivora, `GET /transactions` lists a station's
 * sessions OLDEST first, with no date or active filter, and its items carry no ID
 * token or connector. A "newest 20" read therefore never sees today's session on a
 * charger with a long history. Instead, each station keeps a high-water mark (the
 * highest transaction ID every finder is done with): a scan pages on from it with
 * `after=<mark>`, reads each new candidate in full (`GET /transactions/{id}`, which has
 * the masked ID token and the connector) and hands it to the caller.
 *
 * The mark moves only over sessions that started more than MARK_LAG_MS ago, so a
 * session that starts while another scan is under way is still offered next time.
 * Live (and anything else that looks for a session by token or connector) reuses it.
 */

/** Sessions younger than this stay above the mark and are offered again next scan. */
export const MARK_LAG_MS = 5 * 60_000;
/** Items per list page. */
const PAGE_SIZE = 100;
/** Pages of 100 per scan; the next scan carries on from the mark. */
export const SCAN_MAX_PAGES = 20;
/** Full reads (`GET /transactions/{id}`) per scan. */
export const SCAN_MAX_READS = 10;
/** A scan starts no new page after this long (one read can take 20 s with 429 waits). */
export const SCAN_BUDGET_MS = 15_000;

/**
 * A station whose list has no ID above this is scanned from 0. Above it, a first scan
 * (no mark yet) first seeds the mark near the newest ID (see seedMark), because the
 * list runs oldest first and a scan reads at most SCAN_MAX_PAGES * 100 items per run.
 */
export const SEED_THRESHOLD = 2_000;
/**
 * IDs kept below the newest one when seeding: sessions in that range are scanned
 * normally. Transaction IDs are shared by all of Ivora's stations, so this is a count
 * of IDs, not of this station's sessions.
 */
export const SEED_MARGIN = 1_000;

export interface TransactionScanDeps {
  ivora: Pick<IvoraClient, "listTransactionsAfter" | "getTransaction">;
  marks: Pick<LiveStore, "getTransactionMark" | "advanceTransactionMark">;
  /** Where a seed's search progress is kept (see SeedProgress); unset: not kept. */
  progress?: {
    getSeed(stationId: number): Promise<SeedProgress | null>;
    saveSeed(stationId: number, p: SeedProgress): Promise<void>;
  };
  now?: () => number;
}

export interface TransactionScan {
  /**
   * Only sessions started at or after this time (ms) are read in full and offered;
   * older ones are passed over by their list item. A list item without started_at is
   * read in full. Unset: every session is read.
   */
  since?: number;
  /**
   * Decides from the list item whether to read the session in full; replaces the
   * `since` test. The session tracker reads every item not known to have ended.
   */
  include?: (item: TransactionListItem) => boolean;
  /** Called with each new candidate, oldest first. A throw stops the scan there. */
  offer: (tx: Transaction) => Promise<void>;
  /**
   * Asked before seeding a station with a long history and no mark (a binary search
   * of about 20 to 40 requests, resumed where it stopped with `progress`). False
   * defers it: the scan stops there, not complete, and the station is seeded on a
   * later scan. Unset: always seed.
   */
  seed?: () => boolean;
  /** No new page or full read after this time (ms, on the `now` clock). */
  deadline?: number;
}

export interface TransactionScanResult {
  /** The scan reached the end of the list (false: a page, read or time budget ran out). */
  complete: boolean;
  /** Full reads made. */
  reads: number;
  /** Seeding was deferred (see TransactionScan.seed): nothing was scanned. */
  deferred?: boolean;
}

/**
 * Two saved states of one seed's search, combined: the higher lo and the lower hi both
 * still hold. A lo at or above hi means sessions came in after hi was probed, so the
 * search goes up from lo again. As cpo_save_active_seed does it.
 */
export function mergeSeed(
  old: SeedProgress | null,
  p: SeedProgress,
): SeedProgress {
  const lo = Math.max(old?.lo ?? 0, p.lo);
  const his = [old?.hi, p.hi].filter((h): h is number => h != null);
  const hi = his.length ? Math.min(...his) : null;
  return { lo, hi: hi !== null && hi > lo ? hi : null };
}

/**
 * Seeds a station's mark on its first scan. Finds the station's newest transaction ID
 * with a binary search on `after=<x>&limit=1` (IDs only grow, so "is there anything
 * after x" is monotonic), then moves the mark to SEED_MARGIN IDs below it. About
 * 2 * log2(newest / SEED_THRESHOLD) + log2(newest) cheap requests, whatever the history.
 * With `progress` deps, each probe's result is saved and a later call resumes it, so
 * every scan moves the search forward however short its budget. Sessions below the seed
 * are not scanned; they are found by their webhooks instead. Returns the seeded mark,
 * null when the station has no long history, or "deferred" when `allow` said no.
 */
export async function seedMark(
  d: TransactionScanDeps,
  stationId: number,
  allow: () => boolean = () => true,
): Promise<number | null | "deferred"> {
  const any = async (after: number) =>
    (
      await d.ivora.listTransactionsAfter({
        station_id: stationId,
        after,
        limit: 1,
      })
    ).data.length > 0;
  const save = (p: SeedProgress) => d.progress?.saveSeed(stationId, p);
  let p = (await d.progress?.getSeed(stationId)) ?? null;
  if (!p) {
    if (!(await any(SEED_THRESHOLD))) return null;
    p = { lo: SEED_THRESHOLD, hi: null };
    await save(p);
  }
  if (!allow()) return "deferred";
  let { lo, hi } = p;
  // Two searches at once can save a later lo above an older hi (new sessions came in
  // between): search up from lo again.
  if (hi !== null && hi <= lo) hi = null;
  // IDs are far below 2^40; a list that never ends is not following `after`.
  while (hi === null) {
    const next = lo * 2;
    if (await any(next)) {
      if (next > 2 ** 40) return null;
      lo = next;
    } else hi = next;
    await save({ lo, hi });
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await any(mid)) lo = mid;
    else hi = mid;
    await save({ lo, hi });
  }
  // Now hi = lo + 1 is the newest ID (as of the probe that set hi; newer sessions are
  // above the mark and scanned normally).
  const seed = Math.max(0, hi - SEED_MARGIN);
  await d.marks.advanceTransactionMark(stationId, seed);
  return seed;
}

/**
 * Pages a station's new sessions from its mark and offers each candidate (see the
 * module comment). Moves the mark over what is done; never down.
 */
export async function scanNewTransactions(
  d: TransactionScanDeps,
  stationId: number,
  scan: TransactionScan,
): Promise<TransactionScanResult> {
  const now = d.now ?? Date.now;
  const started = now();
  const deadline = Math.min(
    started + SCAN_BUDGET_MS,
    scan.deadline ?? Infinity,
  );
  let mark = (await d.marks.getTransactionMark(stationId)) ?? 0;
  if (mark === 0) {
    const seeded = await seedMark(d, stationId, scan.seed);
    if (seeded === "deferred")
      return { complete: false, reads: 0, deferred: true };
    mark = seeded ?? 0;
  }
  let after = mark;
  // The highest ID up to which every session is done (offered or too old) and older
  // than MARK_LAG_MS: the new mark. Stops moving at the first young or unread one.
  let done = mark;
  let held = false;
  let reads = 0;
  const settle = async () => {
    if (done > mark) await d.marks.advanceTransactionMark(stationId, done);
  };
  try {
    for (let page = 0; page < SCAN_MAX_PAGES; page++) {
      if (page > 0 && now() > deadline) return { complete: false, reads };
      const cursor = after;
      const res = await d.ivora.listTransactionsAfter({
        station_id: stationId,
        after: cursor,
        limit: PAGE_SIZE,
      });
      for (const item of res.data) {
        // Defensive: the list is filtered by station and cursor already.
        if (item.id <= after) continue;
        after = item.id;
        const listed = item.started_at ? Date.parse(item.started_at) : NaN;
        let startedAt = listed;
        if (scan.include ? scan.include(item) : !(listed < (scan.since ?? 0))) {
          if (reads >= SCAN_MAX_READS || (reads > 0 && now() > deadline))
            return { complete: false, reads };
          reads++;
          const tx = await d.ivora.getTransaction(item.id);
          startedAt = tx.started_at ? Date.parse(tx.started_at) : NaN;
          if (tx.station_id == null || tx.station_id === stationId)
            await scan.offer(tx);
        }
        if (!held && startedAt < now() - MARK_LAG_MS) done = item.id;
        else held = true;
      }
      // Stop on the last page (a short one: Ivora's next_cursor is then still the last
      // ID, not null), and on a cursor that does not move forward.
      const next = res.next_cursor;
      if (!next || res.data.length < PAGE_SIZE || next <= cursor)
        return { complete: true, reads };
      after = Math.max(after, next);
    }
    return { complete: false, reads };
  } finally {
    await settle();
  }
}
