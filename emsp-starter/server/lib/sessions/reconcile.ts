import "server-only";
import type { ReconciliationRow, SessionStore } from "./store";

/**
 * Reconciliation data, for checking what each CPO billed against what its sessions
 * said, per peer and UTC day (of the start), in each currency:
 *
 * - counts of sessions (open, completed, invalid) and of CDRs (and credit CDRs);
 * - COMPLETED sessions without a CDR, and CDRs that name no session we hold;
 * - CDRs of a token we did not issue (no driver of ours to bill), and CDRs in another
 *   currency than their session;
 * - totals: kWh as the sessions say, and energy and cost as the CDRs say, net of credit
 *   CDRs. Amounts are E4 (ten-thousandths of a kWh or of the currency unit), so they
 *   add up exactly.
 *
 * A session that ended minutes ago has no CDR yet: look at days that are over. The
 * database computes it (emsp_reconciliation); the memory store, for demo mode and
 * tests, gives the same figures.
 */
export type ReconciliationTotal = Omit<
  ReconciliationRow,
  | "day"
  | "sessionsWithoutCdrIds"
  | "cdrsWithoutSessionIds"
  | "cdrsUnknownTokenIds"
  | "cdrsCurrencyMismatchIds"
>;

export type Reconciliation = {
  /** First and last UTC day, inclusive. */
  from: string;
  to: string;
  days: ReconciliationRow[];
  /** Per peer and currency, over every day. */
  totals: ReconciliationTotal[];
};

/** The longest range one call covers. */
export const MAX_RECONCILIATION_DAYS = 92;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export class ReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationError";
  }
}

function dayMs(day: string): number {
  const ms = DAY.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day)
    throw new ReconciliationError("Days must be YYYY-MM-DD dates.");
  return ms;
}

const NUMBERS = [
  "sessions",
  "sessionsOpen",
  "sessionsCompleted",
  "sessionsInvalid",
  "sessionKwhE4",
  "sessionsWithoutCdr",
  "cdrs",
  "creditCdrs",
  "cdrsWithoutSession",
  "cdrsUnknownToken",
  "cdrsCurrencyMismatch",
  "cdrEnergyE4",
  "cdrCostExclVatE4",
] as const;

/** Reconciliation for the UTC days `from` to `to`, inclusive; optionally one peer. */
export async function reconcile(
  input: { from: string; to: string; peerId?: string },
  deps: { sessions: SessionStore },
): Promise<Reconciliation> {
  const from = dayMs(input.from);
  const to = dayMs(input.to);
  if (to < from)
    throw new ReconciliationError("The last day is before the first.");
  if ((to - from) / DAY_MS + 1 > MAX_RECONCILIATION_DAYS)
    throw new ReconciliationError(
      `At most ${MAX_RECONCILIATION_DAYS} days at a time.`,
    );
  const days = await deps.sessions.reconcile({
    from: new Date(from).toISOString(),
    to: new Date(to + DAY_MS).toISOString(),
    peerId: input.peerId,
  });

  const totals = new Map<string, ReconciliationTotal>();
  for (const d of days) {
    const key = JSON.stringify([d.peerId, d.currency]);
    const t = totals.get(key);
    if (!t) {
      const {
        day: _day,
        sessionsWithoutCdrIds: _s,
        cdrsWithoutSessionIds: _c,
        cdrsUnknownTokenIds: _u,
        cdrsCurrencyMismatchIds: _m,
        ...first
      } = d;
      totals.set(key, first);
      continue;
    }
    for (const n of NUMBERS) t[n] += d[n];
    t.cdrCostInclVatE4 =
      t.cdrCostInclVatE4 === null || d.cdrCostInclVatE4 === null
        ? null
        : t.cdrCostInclVatE4 + d.cdrCostInclVatE4;
  }
  return { from: input.from, to: input.to, days, totals: [...totals.values()] };
}
