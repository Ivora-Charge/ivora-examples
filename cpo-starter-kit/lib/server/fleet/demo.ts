import "server-only";
import { demoHistory } from "../ivora/demo-history";
import { maskedKey } from "./input";
import type { CardLedger, KeyUsage, LedgerSession } from "./types";

/**
 * The demo card ledger: the sample history's RFID sessions (lib/server/ivora/
 * demo-history.ts), made up offline, by token key. It scans nothing and records
 * nothing; the cards it matches are the demo's sample cards.
 */
export function createDemoLedger(now: () => number = Date.now): CardLedger {
  const sessions = (): LedgerSession[] =>
    demoHistory(now()).transactions.flatMap((t) => {
      const key = maskedKey(t.id_token);
      return key && t.station_id
        ? [
            {
              transactionId: t.id,
              stationId: t.station_id,
              connectorNumber: t.connector_number ?? null,
              key,
              startedAt: t.started_at,
              endedAt: t.ended_at,
              energyWh: t.energy_wh ?? null,
              active: !t.ended_at,
            },
          ]
        : [];
    });
  const within = (s: LedgerSession, since: number, until: number) => {
    const at = s.startedAt ? Date.parse(s.startedAt) : NaN;
    return at >= since && at < until;
  };
  return {
    mode: "demo",
    async usage(since, until) {
      const by = new Map<string, KeyUsage>();
      for (const s of sessions()) {
        if (!within(s, since, until)) continue;
        const u = by.get(s.key) ?? {
          key: s.key,
          sessions: 0,
          running: 0,
          energyWh: 0,
        };
        u.sessions++;
        if (s.active) u.running++;
        u.energyWh += s.energyWh ?? 0;
        by.set(s.key, u);
      }
      return [...by.values()];
    },
    async sessions(key, since, until, limit) {
      return sessions()
        .filter((s) => s.key === key.toUpperCase() && within(s, since, until))
        .sort(
          (a, b) =>
            Date.parse(b.startedAt!) - Date.parse(a.startedAt!) ||
            b.transactionId - a.transactionId,
        )
        .slice(0, limit);
    },
    async getTransactionMark() {
      return null;
    },
    async advanceTransactionMark() {},
    async scannedAt() {
      return new Map();
    },
    async record() {},
    async forget() {},
    async defer() {},
    async due() {
      return [];
    },
  };
}
