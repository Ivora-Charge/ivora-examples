import "server-only";
import type { IvoraClient, Transaction } from "../ivora/types";
import type { LiveStore } from "./types";

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
/** Pages of 100 per scan; the next scan carries on from the mark. */
export const SCAN_MAX_PAGES = 20;
/** Full reads (`GET /transactions/{id}`) per scan. */
export const SCAN_MAX_READS = 10;
/** A scan starts no new page after this long (one read can take 20 s with 429 waits). */
export const SCAN_BUDGET_MS = 15_000;

export interface TransactionScanDeps {
  ivora: Pick<IvoraClient, "listTransactionsAfter" | "getTransaction">;
  marks: Pick<LiveStore, "getTransactionMark" | "advanceTransactionMark">;
  now?: () => number;
}

export interface TransactionScan {
  /**
   * Only sessions started at or after this time (ms) are read in full and offered;
   * older ones are passed over by their list item. A list item without started_at is
   * read in full.
   */
  since: number;
  /** Called with each new candidate, oldest first. A throw stops the scan there. */
  offer: (tx: Transaction) => Promise<void>;
}

export interface TransactionScanResult {
  /** The scan reached the end of the list (false: a page, read or time budget ran out). */
  complete: boolean;
  /** Full reads made. */
  reads: number;
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
  const mark = (await d.marks.getTransactionMark(stationId)) ?? 0;
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
      if (page > 0 && now() - started > SCAN_BUDGET_MS)
        return { complete: false, reads };
      const cursor = after;
      const res = await d.ivora.listTransactionsAfter({
        station_id: stationId,
        after: cursor,
        limit: 100,
      });
      for (const item of res.data) {
        // Defensive: the list is filtered by station and cursor already.
        if (item.id <= after) continue;
        after = item.id;
        const listed = item.started_at ? Date.parse(item.started_at) : NaN;
        let startedAt = listed;
        if (!(listed < scan.since)) {
          if (reads >= SCAN_MAX_READS) return { complete: false, reads };
          reads++;
          const tx = await d.ivora.getTransaction(item.id);
          startedAt = tx.started_at ? Date.parse(tx.started_at) : NaN;
          if (tx.station_id == null || tx.station_id === stationId)
            await scan.offer(tx);
        }
        if (!held && startedAt < now() - MARK_LAG_MS) done = item.id;
        else held = true;
      }
      // Stop on the last page, and on a cursor that does not move forward.
      const next = res.next_cursor;
      if (!next || !res.data.length || next <= cursor)
        return { complete: true, reads };
      after = Math.max(after, next);
    }
    return { complete: false, reads };
  } finally {
    await settle();
  }
}
