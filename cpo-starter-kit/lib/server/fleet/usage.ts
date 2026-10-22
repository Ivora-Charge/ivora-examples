import "server-only";
import { IvoraError, type IvoraClient, type Transaction } from "../ivora";
import type { ReadLimits } from "../ivora/types";
import { scanNewTransactions } from "../live/transactions";
import type { LiveStore, TrackedSession } from "../live/types";
import { maskedKey } from "./input";
import type { CardLedger, LedgerSession } from "./types";

// Filling the card ledger. GET /transactions has no token filter and its items carry no
// ID token, so each station's list is paged from the ledger's own mark and every new
// session is read in full once (GET /transactions/{id}: the masked token, energy and
// times), with the helper Live and free checkouts use (lib/server/live/transactions.ts).
// A session Live's tracker already read (ended, or running and read lately) is taken
// from the tracker instead of being read again. A session still running is read again
// every RECHECK_MS until it ends; a re-read that fails or comes back without a token is
// put off with a growing backoff, so it can't hold a re-read slot. Every read
// stays within the caller's deadline and hands a 429 back at once: the settlement sweep
// and the Cards page run this in the time they have left.

/** A station's list is scanned at most this often. */
export const RESCAN_MS = 60_000;
/** A running session is read again after this long. */
export const RECHECK_MS = 2 * 60_000;
/** Stations scanned per run, least recently scanned first. */
export const MAX_STATIONS = 5;
/** Running sessions read again per run. */
export const MAX_RECHECKS = 10;

export interface CardRefreshDeps {
  ivora: Pick<
    IvoraClient,
    "listAllStations" | "listTransactionsAfter" | "getTransaction"
  >;
  ledger: CardLedger;
  /** Live's session tracker (cpo_active_sessions): its reads are reused. */
  tracker?: Pick<LiveStore, "getTrackedSession">;
  now?: () => number;
}

export interface CardRefresh {
  /** Stations whose list was scanned to its end. */
  stations: number;
  /** Full session reads (from Ivora, or from Live's tracker). */
  reads: number;
  /** Of those, sessions taken from Live's tracker without asking Ivora. */
  reused: number;
  /** Sessions with a token recorded (new or updated). */
  recorded: number;
  /** Ivora answered 429: the run stopped there. */
  limited: boolean;
}

const time = (v: string | null | undefined) =>
  v && !Number.isNaN(Date.parse(v)) ? v : null;

/** What the ledger keeps of a session, or null when it has no ID token or station. */
export function toLedger(
  tx: Transaction,
  stationId: number | null,
): LedgerSession | null {
  const key = maskedKey(tx.id_token);
  const station = tx.station_id ?? stationId;
  if (!key || !station || !Number.isSafeInteger(tx.id) || tx.id <= 0)
    return null;
  const endedAt = time(tx.ended_at);
  return {
    transactionId: tx.id,
    stationId: station,
    connectorNumber:
      typeof tx.connector_number === "number" && tx.connector_number > 0
        ? tx.connector_number
        : null,
    key,
    startedAt: time(tx.started_at),
    endedAt,
    energyWh:
      typeof tx.energy_wh === "number" &&
      Number.isSafeInteger(tx.energy_wh) &&
      tx.energy_wh >= 0
        ? tx.energy_wh
        : null,
    // The API may report active as null while it does not know: running until it ends.
    active: !endedAt && tx.active !== false,
  };
}

/** A session as Live's tracker has it, in the API's shape. */
const fromTracker = (t: TrackedSession): Transaction => ({
  id: t.transactionId,
  station_id: t.stationId,
  connector_id: t.connectorId,
  connector_number: t.connectorNumber,
  active: t.active,
  id_token: t.idToken,
  started_at: t.startedAt,
  ended_at: t.endedAt,
  energy_wh: t.energyWh,
});

const limited429 = (e: unknown) => e instanceof IvoraError && e.status === 429;

function logFailure(what: string, e: unknown) {
  console.error(`cpo-starter-kit: card ${what} failed:`, {
    error:
      e instanceof IvoraError ? e.code : e instanceof Error ? e.name : "error",
  });
}

/**
 * Brings the card ledger up to date as far as `deadline` (ms) allows: first the running
 * sessions due a re-read, then the new sessions of the stations scanned least recently.
 * Safe to run twice at once (records only grow; marks only move up). The demo ledger
 * has nothing to fill.
 */
export async function refreshCardSessions(
  d: CardRefreshDeps,
  o: { deadline: number; maxStations?: number; maxRechecks?: number },
): Promise<CardRefresh> {
  const r: CardRefresh = {
    stations: 0,
    reads: 0,
    reused: 0,
    recorded: 0,
    limited: false,
  };
  if (d.ledger.mode === "demo") return r;
  const now = d.now ?? Date.now;
  const limits: ReadLimits = { deadline: o.deadline, failOn429: true };
  /** Live's read of the session when it is final or fresh enough; else Ivora's. */
  const read = async (id: number): Promise<Transaction> => {
    let t: TrackedSession | null = null;
    try {
      t = (await d.tracker?.getTrackedSession(id)) ?? null;
    } catch {
      // The tracker is a shortcut: Ivora has the session too.
    }
    if (
      t?.idToken &&
      (!t.active || Date.parse(t.checkedAt) > now() - RECHECK_MS)
    ) {
      r.reused++;
      return fromTracker(t);
    }
    return d.ivora.getTransaction(id, limits);
  };
  const ivora = {
    listTransactionsAfter: (
      q: Parameters<IvoraClient["listTransactionsAfter"]>[0],
    ) => d.ivora.listTransactionsAfter(q, limits),
    getTransaction: read,
  };
  /** Records the session; false when it has no token the ledger can key. */
  const record = async (tx: Transaction, stationId: number | null) => {
    const s = toLedger(tx, stationId);
    if (!s) return false;
    await d.ledger.record(s);
    r.recorded++;
    return true;
  };

  for (const due of await d.ledger.due(
    now() - RECHECK_MS,
    o.maxRechecks ?? MAX_RECHECKS,
  )) {
    if (now() >= o.deadline) return r;
    try {
      r.reads++;
      // Without a token now (the API stopped showing it): try again later.
      if (!(await record(await read(due.transactionId), due.stationId)))
        await d.ledger.defer(due.transactionId);
    } catch (e) {
      if (e instanceof IvoraError && e.status === 404)
        await d.ledger.forget(due.transactionId);
      else if (limited429(e)) return { ...r, limited: true };
      else {
        logFailure("session re-read", e);
        // Put off with a backoff, so it leaves its slot to the other running ones.
        await d.ledger.defer(due.transactionId);
      }
    }
  }

  if (now() >= o.deadline) return r;
  let stations;
  try {
    stations = (await d.ivora.listAllStations(limits)).data;
  } catch (e) {
    if (limited429(e)) return { ...r, limited: true };
    logFailure("station list", e);
    return r;
  }
  const scanned = await d.ledger.scannedAt();
  const t = now();
  const order = stations
    .map((s) => ({ id: s.id, at: scanned.get(s.id) ?? 0 }))
    .filter((s) => t - s.at >= RESCAN_MS)
    .sort((a, b) => a.at - b.at || a.id - b.id)
    .slice(0, o.maxStations ?? MAX_STATIONS);
  // A station with a long history and no mark yet is seeded with a binary search for
  // its newest session (lib/server/live/transactions.ts): at most one per run.
  let seeds = 0;
  for (const s of order) {
    if (now() >= o.deadline) break;
    try {
      const res = await scanNewTransactions(
        {
          ivora,
          marks: {
            getTransactionMark: (id) => d.ledger.getTransactionMark(id),
            advanceTransactionMark: (id, tx) =>
              d.ledger.advanceTransactionMark(id, tx),
          },
          now,
        },
        s.id,
        {
          include: () => true,
          offer: async (tx) => void (await record(tx, s.id)),
          seed: () => seeds++ < 1,
          deadline: o.deadline,
        },
      );
      r.reads += res.reads;
      if (res.complete) {
        const mark = (await d.ledger.getTransactionMark(s.id)) ?? 0;
        await d.ledger.advanceTransactionMark(s.id, mark, true);
        r.stations++;
      }
    } catch (e) {
      if (limited429(e)) return { ...r, limited: true };
      // One station's problem leaves the others to scan; it is tried again next run.
      logFailure("station scan", e);
    }
  }
  return r;
}
