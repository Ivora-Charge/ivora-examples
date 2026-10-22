import { describe, expect, it, vi } from "vitest";
import { IvoraError } from "@/lib/server/ivora/errors";
import type { Transaction } from "@/lib/server/ivora/types";
import { createDemoLiveStore, memoryDemoLive } from "@/lib/server/live/demo";
import {
  MARK_LAG_MS,
  SCAN_MAX_READS,
  scanNewTransactions,
} from "@/lib/server/live/transactions";

// The station session finder against an API-shaped fake of GET /transactions: oldest
// first, paged with `after`, items without the ID token or connector.

const NOW = Date.parse("2026-10-22T10:00:00Z");
const OLD = "2025-01-01T00:00:00Z";
const STATION = 9103;

function api(rows: Transaction[]) {
  const list = vi.fn(
    async (o: { station_id: number; after: number; limit?: number }) => {
      const all = rows
        .filter((t) => t.station_id === o.station_id && t.id > o.after)
        .sort((a, b) => a.id - b.id);
      const data = all.slice(0, o.limit ?? 100).map((t) => ({
        id: t.id,
        station_id: t.station_id,
        active: t.active,
        started_at: t.started_at,
        ended_at: t.ended_at,
      }));
      return {
        data,
        // As Ivora: the last item's ID, also on the last page; `after` when empty.
        next_cursor: data.length ? data[data.length - 1].id : o.after,
      };
    },
  );
  const read = vi.fn(async (id: number) => {
    const t = rows.find((x) => x.id === id);
    if (!t) throw new IvoraError(404, "transaction_not_found", "Unknown");
    return structuredClone(t);
  });
  return {
    list,
    read,
    ivora: { listTransactionsAfter: list, getTransaction: read },
  };
}

const tx = (id: number, startedAt: string, o: Partial<Transaction> = {}) =>
  ({
    id,
    station_id: STATION,
    connector_id: 91031,
    active: false,
    id_token: "****OTHR",
    started_at: startedAt,
    ended_at: startedAt,
    ...o,
  }) satisfies Transaction;

const history = (n: number) =>
  Array.from({ length: n }, (_, i) => tx(i + 1, OLD));

const marks = () => createDemoLiveStore(memoryDemoLive());

describe("finding new sessions at a station", () => {
  it("pages past 1,200 old sessions without reading them and finds the new one", async () => {
    const recent = new Date(NOW - 60_000).toISOString();
    const a = api([...history(1200), tx(1201, recent, { active: true })]);
    const m = marks();
    const offered: number[] = [];
    const r = await scanNewTransactions(
      { ivora: a.ivora, marks: m, now: () => NOW },
      STATION,
      { since: NOW - 10 * 60_000, offer: async (t) => void offered.push(t.id) },
    );
    expect(r).toEqual({ complete: true, reads: 1 });
    expect(offered).toEqual([1201]);
    expect(a.read).toHaveBeenCalledTimes(1);
    // 13 pages, plus the one-item probe that finds no long history to seed past.
    expect(a.list).toHaveBeenCalledTimes(14);
    // The new session is younger than MARK_LAG_MS: it stays above the mark.
    expect(await m.getTransactionMark(STATION)).toBe(1200);
    // The next scan starts at the mark: one page, and the young session offered again.
    a.list.mockClear();
    await scanNewTransactions(
      { ivora: a.ivora, marks: m, now: () => NOW },
      STATION,
      { since: NOW - 10 * 60_000, offer: async (t) => void offered.push(t.id) },
    );
    expect(a.list).toHaveBeenCalledTimes(1);
    expect(a.list).toHaveBeenCalledWith({
      station_id: STATION,
      after: 1200,
      limit: 100,
    });
    expect(offered).toEqual([1201, 1201]);
    // Once it is older than the lag, the mark moves over it.
    await scanNewTransactions(
      { ivora: a.ivora, marks: m, now: () => NOW + MARK_LAG_MS },
      STATION,
      { since: NOW - 10 * 60_000, offer: async () => {} },
    );
    expect(await m.getTransactionMark(STATION)).toBe(1201);
  });

  it("keeps the mark below a session whose read or offer failed", async () => {
    const at = new Date(NOW - 30 * 60_000).toISOString();
    const a = api([tx(1, OLD), tx(2, at), tx(3, at)]);
    const m = marks();
    a.read.mockRejectedValueOnce(new IvoraError(503, "unavailable", "Down"));
    await expect(
      scanNewTransactions(
        { ivora: a.ivora, marks: m, now: () => NOW },
        STATION,
        {
          since: NOW - 60 * 60_000,
          offer: async () => {},
        },
      ),
    ).rejects.toThrow(IvoraError);
    expect(await m.getTransactionMark(STATION)).toBe(1);
    const offer = vi.fn(async (t: Transaction) => {
      if (t.id === 3) throw new Error("store down");
    });
    await expect(
      scanNewTransactions(
        { ivora: a.ivora, marks: m, now: () => NOW },
        STATION,
        {
          since: NOW - 60 * 60_000,
          offer,
        },
      ),
    ).rejects.toThrow("store down");
    expect(await m.getTransactionMark(STATION)).toBe(2);
  });

  it("reads at most SCAN_MAX_READS sessions per scan and carries on next time", async () => {
    const at = new Date(NOW - 30 * 60_000).toISOString();
    const rows = Array.from({ length: SCAN_MAX_READS + 5 }, (_, i) =>
      tx(i + 1, at),
    );
    const a = api(rows);
    const m = marks();
    const seen: number[] = [];
    const scan = () =>
      scanNewTransactions(
        { ivora: a.ivora, marks: m, now: () => NOW },
        STATION,
        {
          since: NOW - 60 * 60_000,
          offer: async (t) => void seen.push(t.id),
        },
      );
    expect(await scan()).toEqual({ complete: false, reads: SCAN_MAX_READS });
    expect(await m.getTransactionMark(STATION)).toBe(SCAN_MAX_READS);
    expect(await scan()).toEqual({ complete: true, reads: 5 });
    expect(seen).toEqual(rows.map((r) => r.id));
  });

  it("reads a list item that has no start time, and never moves the mark down", async () => {
    const a = api([tx(5, OLD, { started_at: null })]);
    const m = marks();
    await m.advanceTransactionMark(STATION, 4);
    const offer = vi.fn(async () => {});
    await scanNewTransactions(
      { ivora: a.ivora, marks: m, now: () => NOW },
      STATION,
      {
        since: NOW,
        offer,
      },
    );
    expect(a.read).toHaveBeenCalledWith(5);
    expect(offer).toHaveBeenCalledTimes(1);
    await m.advanceTransactionMark(STATION, 2);
    expect(await m.getTransactionMark(STATION)).toBe(4);
  });
});
