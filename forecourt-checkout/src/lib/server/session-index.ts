import type { ExternalSession, IvoraClient } from "./ivora";

// The pay-in-store reads (console polls, the driver's counter screen, meter
// samples, the POS sessions list) need the open sessions and the last day's
// in-store sales. Ivora's session list is ordered by opaque ID, not time, so
// finding them means reading every page. This index does that at most once a
// minute per server instance and keeps the result. In between, a read that
// knows its sale looks it up by application_reference and puts it here; a
// read that sees something the index can't explain (a connector in use with
// no session, a meter sample for an unknown transaction) may rescan sooner,
// but never more often than INDEX_RESCAN_MS.

/** A full rescan at most this often in normal reads. */
export const INDEX_TTL_MS = 60_000;
/** A read that sees something the index can't explain may rescan after this long. */
export const INDEX_RESCAN_MS = 15_000;
/** Closed sessions stay in the index this long (the console's unpaid list). */
export const INDEX_WINDOW_MS = 24 * 60 * 60 * 1000;

const CLOSED = new Set(["completed", "canceled"]);

type Entry = { session: ExternalSession; seenAt: number };

export type IndexRead = {
  sessions: ExternalSession[];
  /** The last full listing stopped at the page ceiling: some sessions may be missing. */
  truncated: boolean;
};

export class SessionIndex {
  private entries = new Map<string, Entry>();
  private scannedAt: number | null = null;
  private truncated = false;
  private scanning: Promise<void> | null = null;

  constructor(
    private readonly api: Pick<IvoraClient, "listAllSessions">,
    private readonly now: () => number,
  ) {}

  /** The indexed sessions, rescanning when the index is old (or `rescan` and not too recent). */
  async read(options: { rescan?: boolean } = {}): Promise<IndexRead> {
    const now = this.now();
    const age = this.scannedAt === null ? Infinity : now - this.scannedAt;
    if (age >= INDEX_TTL_MS || (options.rescan && age >= INDEX_RESCAN_MS))
      await this.scan(now);
    return { sessions: this.current(now), truncated: this.truncated };
  }

  /** A fresher copy of one session, from a lookup by ID or application_reference. */
  put(session: ExternalSession) {
    this.entries.set(session.id, { session, seenAt: this.now() });
  }

  private current(now: number) {
    const keep: ExternalSession[] = [];
    for (const [id, { session }] of this.entries) {
      if (CLOSED.has(session.status) && !recent(session, now))
        this.entries.delete(id);
      else keep.push(session);
    }
    return keep;
  }

  private scan(now: number) {
    // Concurrent reads share one listing.
    this.scanning ??= this.api
      .listAllSessions()
      .then((list) => {
        const next = new Map<string, Entry>();
        for (const session of list.sessions)
          if (!CLOSED.has(session.status) || recent(session, now))
            next.set(session.id, { session, seenAt: now });
        // A put() while the listing ran is fresher than what it read, and a
        // session looked up by reference stays even if a truncated listing missed it.
        for (const [id, entry] of this.entries)
          if (entry.seenAt >= now || !next.has(id)) next.set(id, entry);
        this.entries = next;
        this.scannedAt = now;
        this.truncated = list.truncated;
      })
      .finally(() => {
        this.scanning = null;
      });
    return this.scanning;
  }
}

const recent = (s: ExternalSession, now: number) =>
  now - Date.parse(s.created_at) < INDEX_WINDOW_MS;
