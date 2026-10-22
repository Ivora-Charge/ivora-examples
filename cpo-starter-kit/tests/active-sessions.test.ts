import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IvoraError } from "@/lib/server/ivora/errors";
import type {
  IvoraClient,
  Station,
  Transaction,
} from "@/lib/server/ivora/types";
import {
  endedSessions,
  REFRESH_AFTER_MS,
  SEEDS_PER_SYNC,
  STALL_AFTER_MS,
  STALLED_REFRESH_AFTER_MS,
  SYNC_BUDGET_MS,
  SYNC_INTERVAL_MS,
  SYNC_MAX_CALLS,
  SYNC_MAX_STATIONS,
  syncActiveSessions,
} from "@/lib/server/live/active";
import { createDemoLiveStore, memoryDemoLive } from "@/lib/server/live/demo";
import {
  ENDED_PAGE,
  handleEvent,
  loadLive,
  loadStation,
  METER_REREAD_MS,
  resetForgetForTests,
  type IvoraEvent,
  type LiveDeps,
} from "@/lib/server/live/service";
import {
  SEED_MARGIN,
  scanNewTransactions,
} from "@/lib/server/live/transactions";
import type {
  LiveStore,
  TrackedSession,
  TrackerMark,
} from "@/lib/server/live/types";
import type { Staff } from "@/lib/server/team/types";

// The Live view's running sessions against an API-shaped fake of Ivora: GET
// /transactions lists oldest first, pages with `after` (next_cursor is the last ID,
// also on the last page), and its items carry no ID token or connector; GET
// /transactions/{id} has them.

const NOW = Date.parse("2026-10-22T10:00:00Z");
const OLD = "2025-01-01T00:00:00Z";
const STATION = 70;
const OPERATOR = "10000000-0000-4000-8000-0000000000aa";
const viewer: Staff = {
  userId: "00000000-0000-4000-8000-000000000001",
  email: "viewer@example.com",
  role: "viewer",
  operatorId: OPERATOR,
  operatorName: "Sample Operator",
  demo: false,
};

const tx = (id: number, o: Partial<Transaction> = {}): Transaction => ({
  id,
  station_id: STATION,
  connector_id: 701,
  connector_number: 1,
  active: false,
  id_token: "****OTHR",
  started_at: OLD,
  ended_at: OLD,
  energy_wh: 1000,
  ...o,
});
const running = (id: number, o: Partial<Transaction> = {}) =>
  tx(id, {
    active: true,
    ended_at: null,
    started_at: new Date(NOW - 3_600_000).toISOString(),
    ...o,
  });
const history = (n: number, station = STATION, from = 1) =>
  Array.from({ length: n }, (_, i) => tx(from + i, { station_id: station }));

const station = (id: number, name: string): Station => ({
  id,
  name,
  online: true,
  location_id: 5,
  connectors: [{ id: 701, number: 1, status: "Charging" }],
});

function api(rows: Transaction[], stations = [station(STATION, "DEPOT-01")]) {
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
      // As Ivora does: the last item's ID, also on the last page; `after` when empty.
      return {
        data,
        next_cursor: data.length ? data[data.length - 1].id : o.after,
      };
    },
  );
  const read = vi.fn(async (id: number) => {
    const t = rows.find((x) => x.id === id);
    if (!t) throw new IvoraError(404, "transaction_not_found", "Unknown");
    return structuredClone(t);
  });
  const ivora = {
    mode: "live",
    listTransactionsAfter: list,
    getTransaction: read,
    // The old, wrong read: nothing may use it for Live.
    listTransactions: vi.fn(async () => {
      throw new Error("Live must not read the oldest-first list");
    }),
    listAllLocations: async () => ({
      data: [{ id: 5, name: "Depot", latitude: null, longitude: null }],
      truncated: false,
    }),
    listAllStations: async () => ({ data: stations, truncated: false }),
    getStation: async (id: number) => stations.find((s) => s.id === id)!,
    listFaults: async () => [],
  } as unknown as IvoraClient;
  return { rows, list, read, ivora };
}

/**
 * The demo store with an unbounded tracker, the way the database keeps it (the demo's
 * cookie holds only a few sessions).
 */
function bigStore(): LiveStore {
  const rows = new Map<number, TrackedSession>();
  const marks = new Map<number, TrackerMark>();
  const newestFirst = (l: TrackedSession[]) =>
    l.sort((a, b) => b.transactionId - a.transactionId);
  return {
    ...createDemoLiveStore(memoryDemoLive()),
    async listActiveSessions(o = {}) {
      return newestFirst(
        [...rows.values()].filter(
          (t) =>
            t.active &&
            (o.stationId === undefined || t.stationId === o.stationId),
        ),
      );
    },
    async listEndedSessions(stationId, o = {}) {
      return newestFirst(
        [...rows.values()].filter(
          (t) =>
            !t.active &&
            t.stationId === stationId &&
            (o.before === undefined || t.transactionId < o.before),
        ),
      ).slice(0, o.limit ?? 20);
    },
    async getTrackedSession(id) {
      return rows.get(id) ?? null;
    },
    async trackSession(t) {
      const old = rows.get(t.transactionId);
      if (old && !old.active) return;
      const now = new Date().toISOString();
      const energy = Math.max(t.energyWh ?? -1, old?.energyWh ?? -1);
      rows.set(t.transactionId, {
        ...t,
        energyWh: energy < 0 ? null : energy,
        checkedAt: now,
        changedAt:
          !old || !t.active || energy !== (old.energyWh ?? -1)
            ? now
            : old.changedAt,
      });
    },
    async forgetSession(id) {
      rows.delete(id);
    },
    async forgetRemovedStations(keep) {
      for (const [id, t] of rows)
        if (!keep.includes(t.stationId)) rows.delete(id);
      for (const id of marks.keys()) if (!keep.includes(id)) marks.delete(id);
    },
    async getTrackerMark(id) {
      return marks.get(id)?.mark ?? null;
    },
    async listTrackerMarks() {
      return new Map(marks);
    },
    async advanceTrackerMark(id, t, o = {}) {
      const m = marks.get(id) ?? { mark: 0, scannedAt: null };
      marks.set(id, {
        mark: Math.max(m.mark, t),
        scannedAt: o.scanned ? new Date().toISOString() : m.scannedAt,
      });
    },
  };
}

/** A test clock; the stores stamp with Date, so it moves the system time too. */
function clock(start = NOW) {
  let t = start;
  return {
    now: () => t,
    add(ms: number) {
      t += ms;
      vi.setSystemTime(t);
    },
  };
}

function deps(
  a: ReturnType<typeof api>,
  now = () => NOW,
  store: LiveStore = createDemoLiveStore(memoryDemoLive()),
) {
  const d: LiveDeps = { store, ivora: a.ivora, now, sleep: async () => {} };
  return { d, store };
}

beforeEach(() => {
  resetForgetForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("running sessions with a long, oldest-first history", () => {
  it("shows exactly the 2 current sessions among 1,000+ old ones, labelled", async () => {
    const a = api([
      ...history(1200),
      running(1201, { id_token: "****STAF" }),
      running(1202, { connector_id: 702, id_token: "****FREE" }),
    ]);
    const { d, store } = deps(a);
    await store.putStaffToken(OPERATOR, {
      idToken: "XXXXXXXXSTAF",
      tokenId: 1,
    });
    await store.putFreeToken(OPERATOR, { idToken: "YYYYYYYYFREE", tokenId: 2 });
    const r = await loadLive(d, viewer);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.live.sessions.map((s) => [s.id, s.staff, s.free, s.connectorId]),
    ).toEqual([
      [1202, false, true, 702],
      [1201, true, false, 701],
    ]);
    expect(r.live.counts.charging).toBe(2);
    expect(r.live.sessionsComplete).toBe(true);
    expect(r.live.retryAfter).toBeNull();
    // Old sessions were passed over by their list item, never read in full.
    expect(a.read.mock.calls.map((c) => c[0]).sort()).toEqual([1201, 1202]);
    // One seeding probe (nothing above 2,000), then 13 pages: the short last page
    // ends the scan, with no extra empty page.
    expect(a.list.mock.calls.length).toBe(14);
  });

  it("rebuilds on a cold start, then pages on from the stored mark, not from 0", async () => {
    const a = api([...history(1200), running(1201)]);
    const { d, store } = deps(a);
    await syncActiveSessions(d, [STATION]);
    expect(await store.getTrackerMark(STATION)).toBe(1201);
    // Another instance, a minute later: same tables.
    a.list.mockClear();
    a.rows.push(running(1202, { connector_id: 702 }));
    vi.setSystemTime(NOW + 60_000);
    const later = deps(a, () => NOW + 60_000, store);
    const s = await syncActiveSessions(later.d, [STATION]);
    expect(s.sessions.map((x) => x.transactionId)).toEqual([1202, 1201]);
    expect(a.list.mock.calls.every((c) => c[0].after >= 1201)).toBe(true);
  });

  it("seeds the mark on a first scan of 50,000 old sessions and finds the new one", async () => {
    const a = api([...history(50_000), running(50_001)]);
    const { d, store } = deps(a);
    const s = await syncActiveSessions(d, [STATION]);
    expect(s.sessions.map((x) => x.transactionId)).toEqual([50_001]);
    expect(s.complete).toBe(true);
    // A binary search plus about SEED_MARGIN / 100 pages, not 500 pages.
    expect(a.list.mock.calls.length).toBeLessThan(
      30 + Math.ceil(SEED_MARGIN / 100) + 2,
    );
    expect(await store.getTrackerMark(STATION)).toBe(50_001);
    expect(a.read).toHaveBeenCalledTimes(1);
    expect(
      a.list.mock.calls.some((c) => c[0].after === 50_001 - SEED_MARGIN),
    ).toBe(true);
  });

  it("seeds the checkout finder's mark the same way", async () => {
    const a = api([...history(50_000), running(50_001)]);
    const store = createDemoLiveStore(memoryDemoLive());
    const seen: number[] = [];
    await scanNewTransactions(
      { ivora: a.ivora, marks: store, now: () => NOW },
      STATION,
      {
        since: NOW - 10 * 60_000,
        offer: async (t) => void seen.push(t.id),
      },
    );
    expect(seen).toEqual([]);
    // The session started an hour ago: below `since`, but the scan was cheap.
    expect(a.list.mock.calls.length).toBeLessThan(75);
  });

  it("keeps a station that is not scanned yet out of the way of the others", async () => {
    const stations = [station(70, "A"), station(71, "B")];
    const a = api(
      [
        ...history(1200, 70),
        ...history(5, 71, 5001),
        running(6000, { station_id: 71 }),
      ],
      stations,
    );
    const { d } = deps(a);
    const s = await syncActiveSessions(d, [70, 71]);
    expect(s.sessions.map((x) => [x.stationId, x.transactionId])).toEqual([
      [71, 6000],
    ]);
  });
});

describe("many tracked sessions", () => {
  it("counts every running session, the overnight one too, past 500 ended ones a day", async () => {
    // 2 running from last night (low IDs), then 700 ended today, then 1 running now.
    const rows = [
      running(10, { started_at: new Date(NOW - 10 * 3_600_000).toISOString() }),
      running(11, { connector_id: 702, connector_number: 2 }),
      ...history(700, STATION, 100).map((t) => ({
        ...t,
        started_at: new Date(NOW - 3_600_000).toISOString(),
        ended_at: new Date(NOW - 1_800_000).toISOString(),
      })),
      running(900, { connector_id: 703, connector_number: 3 }),
    ];
    const a = api(rows);
    const store = bigStore();
    const { d } = deps(a, () => NOW, store);
    for (const t of rows) await store.trackSession(trackedOf(t));
    await store.advanceTrackerMark(STATION, 900, { scanned: true });
    const r = await loadLive(d, viewer);
    expect(r.ok && r.live.sessions.map((s) => s.id)).toEqual([900, 11, 10]);
    expect(r.ok && r.live.counts.charging).toBe(3);
    // The station page: running ones, then the newest page of ended ones.
    const p = await loadStation(d, viewer, STATION);
    if (!p.ok || !p.detail) throw new Error("no detail");
    expect(p.detail.recent.slice(0, 3).map((x) => [x.id, x.active])).toEqual([
      [900, true],
      [11, true],
      [10, true],
    ]);
    expect(p.detail.recent.length).toBe(3 + ENDED_PAGE);
    expect(p.detail.recent[3].id).toBe(799);
    expect(p.detail.endedBefore).toBe(780);
    const next = await loadStation(d, viewer, STATION, {
      endedBefore: p.detail.endedBefore!,
    });
    expect(next.ok && next.detail?.recent[3].id).toBe(779);
  });

  it("reads one station's running sessions in the store, not all of them", async () => {
    const a = api([running(1, { station_id: 71 }), running(2)]);
    const store = bigStore();
    const spy = vi.spyOn(store, "listActiveSessions");
    const { d } = deps(a, () => NOW, store);
    await loadStation(d, viewer, STATION);
    expect(spy.mock.calls.every((c) => c[0]?.stationId === STATION)).toBe(true);
  });
});

describe("the request budget", () => {
  const fleet = (n: number) =>
    Array.from({ length: n }, (_, i) => station(100 + i, `S${i}`));
  /** n stations with 30,000 old sessions each (IDs interleaved) and one running. */
  function longHistories(n: number) {
    const rows: Transaction[] = [];
    for (let i = 0; i < 30_000; i++)
      rows.push(tx(i * n + 1 + (i % n), { station_id: 100 + (i % n) }));
    for (let s = 0; s < n; s++)
      rows.push(running(30_000 * n + 1 + s, { station_id: 100 + s }));
    return rows;
  }

  it("caps a cold start of 10 long-history stations and carries on over the next loads", async () => {
    const c = clock();
    const a = api(longHistories(10), fleet(10));
    const { d, store } = deps(a, c.now, bigStore());
    const ids = fleet(10).map((s) => s.id);
    const first = await syncActiveSessions(d, ids);
    expect(
      a.list.mock.calls.length + a.read.mock.calls.length,
    ).toBeLessThanOrEqual(SYNC_MAX_CALLS);
    expect((await store.listTrackerMarks()).size).toBeLessThanOrEqual(
      SEEDS_PER_SYNC,
    );
    // Stations never scanned were left: that matters, so the note shows.
    expect(first.complete).toBe(false);
    let s = first;
    for (let load = 0; load < 10 && s.sessions.length < 10; load++) {
      c.add(10_000);
      s = await syncActiveSessions(d, ids);
    }
    expect(s.sessions.length).toBe(10);
    c.add(SYNC_INTERVAL_MS);
    expect((await syncActiveSessions(d, ids)).complete).toBe(true);
  });

  it("stops at the first 429 and hands its Retry-After to the page", async () => {
    const a = api([...history(1200), running(1201)]);
    const { d } = deps(a);
    a.list.mockImplementationOnce(async () => {
      throw new IvoraError(429, "rate_limited", "slow", undefined, 42);
    });
    const r = await loadLive(d, viewer);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.live.retryAfter).toBe(42);
    expect(r.live.sessionsComplete).toBe(false);
    // Nothing after the 429.
    expect(a.list).toHaveBeenCalledTimes(1);
    expect(a.read).not.toHaveBeenCalled();
  });

  it("asks the client to hand a 429 back instead of waiting it out", async () => {
    const a = api([running(1)]);
    const { d } = deps(a);
    await syncActiveSessions(d, [STATION]);
    const calls = [...a.list.mock.calls, ...a.read.mock.calls] as unknown[][];
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c[1]).toMatchObject({ failOn429: true });
  });

  it("starts no request after its time budget", async () => {
    const c = clock();
    const a = api([...history(5000), running(5001)], fleet(3));
    // Each list page takes 1.5 s.
    a.list.mockImplementation(async () => {
      c.add(1_500);
      return { data: [], next_cursor: 0 };
    });
    const { d } = deps(a, c.now, bigStore());
    const s = await syncActiveSessions(d, [100, 101, 102, 103, 104, 105]);
    expect(a.list.mock.calls.length).toBeLessThanOrEqual(
      Math.ceil(SYNC_BUDGET_MS / 1_500),
    );
    expect(s.complete).toBe(false);
  });

  it("does not show the note for chargers checked a moment ago and left for the next load", async () => {
    const c = clock();
    const n = SYNC_MAX_STATIONS + 5;
    const a = api([], fleet(n));
    const { d } = deps(a, c.now, bigStore());
    const ids = fleet(n).map((s) => s.id);
    await syncActiveSessions(d, ids);
    c.add(1_000);
    await syncActiveSessions(d, ids);
    c.add(SYNC_INTERVAL_MS);
    a.list.mockClear();
    const s = await syncActiveSessions(d, ids);
    expect(new Set(a.list.mock.calls.map((c) => c[0].station_id)).size).toBe(
      SYNC_MAX_STATIONS,
    );
    expect(s.complete).toBe(true);
  });
});

describe("webhooks and gaps", () => {
  const event = (type: string, data: Record<string, unknown>): IvoraEvent => ({
    id: `evt_${Math.random()}`,
    type,
    tenant_id: 42,
    station_id: STATION,
    data,
  });
  // As Ivora sends it: resource_id is the session's own ID (ecs_...), the transaction
  // is in the session's usage.
  const sessionEvent = (transactionId: number, status: string): IvoraEvent => ({
    id: `evt_${Math.random()}`,
    type: "charging_session.status_changed",
    tenant_id: 42,
    resource_id: "ecs_5f2a9c0d1e",
    data: {
      session_id: "ecs_5f2a9c0d1e",
      status,
      previous_status: "starting",
      session: {
        id: "ecs_5f2a9c0d1e",
        status,
        usage: { transaction_id: transactionId, active: true, energy_wh: 10 },
      },
    },
  });

  it("tracks a session from its webhook and ends it on the ended event, for good", async () => {
    const a = api([...history(1200), running(1201)]);
    const { d, store } = deps(a);
    // Mark the station scanned so only the webhook can have found the session.
    await store.advanceTrackerMark(STATION, 1201);
    await handleEvent(d, sessionEvent(1201, "charging"));
    expect(
      (await store.listActiveSessions()).map((t) => t.transactionId),
    ).toEqual([1201]);
    // Ended in Ivora; its ended event arrives.
    a.rows[1200] = tx(1201, { ended_at: new Date(NOW).toISOString() });
    await handleEvent(d, sessionEvent(1201, "completed"));
    expect(await store.listActiveSessions()).toEqual([]);
    // A late meter.sampled that was read before the end can't reopen it.
    await store.trackSession({
      transactionId: 1201,
      stationId: STATION,
      connectorId: 701,
      connectorNumber: 1,
      idToken: "****OTHR",
      startedAt: OLD,
      endedAt: null,
      energyWh: 5,
      active: true,
    });
    expect(await store.listActiveSessions()).toEqual([]);
    expect(await store.getTrackedSession(1201)).toMatchObject({
      active: false,
    });
  });

  it("reads the transaction of a session event from session.usage, not resource_id", async () => {
    const a = api([running(1201)]);
    const { d, store } = deps(a);
    await handleEvent(d, sessionEvent(1201, "charging"));
    expect(a.read.mock.calls.map((c) => c[0])).toEqual([1201]);
    expect((await store.listActiveSessions()).length).toBe(1);
    // Before the charger started there is no usage yet: nothing to read.
    a.read.mockClear();
    const pending = sessionEvent(1201, "pending");
    await handleEvent(d, {
      ...pending,
      data: { ...pending.data, session: { status: "pending", usage: null } },
    });
    expect(a.read).not.toHaveBeenCalled();
  });

  it("re-reads a session on meter.sampled at most every 5 minutes, always on a status change", async () => {
    const c = clock();
    const a = api([running(1201)]);
    const { d } = deps(a, c.now);
    await handleEvent(d, event("meter.sampled", { transaction_id: 1201 }));
    expect(a.read).toHaveBeenCalledTimes(1);
    c.add(60_000);
    await handleEvent(d, event("meter.sampled", { transaction_id: 1201 }));
    expect(a.read).toHaveBeenCalledTimes(1);
    await handleEvent(d, sessionEvent(1201, "charging"));
    expect(a.read).toHaveBeenCalledTimes(2);
    c.add(METER_REREAD_MS);
    await handleEvent(d, event("meter.sampled", { transaction_id: 1201 }));
    expect(a.read).toHaveBeenCalledTimes(3);
  });

  it("ignores an event for a transaction of another station", async () => {
    const a = api([running(1201, { station_id: 99 })]);
    const { d, store } = deps(a);
    await handleEvent(d, event("meter.sampled", { transaction_id: 1201 }));
    expect(await store.listActiveSessions()).toEqual([]);
  });

  it("repairs a webhook gap: finds a missed start by scanning and a missed end by re-reading", async () => {
    const c = clock();
    const a = api([...history(1200), running(1201)]);
    const { d } = deps(a, c.now);
    expect((await syncActiveSessions(d, [STATION])).sessions).toHaveLength(1);
    // No webhook arrives for either change.
    a.rows[1200] = tx(1201, { ended_at: new Date(c.now()).toISOString() });
    a.rows.push(running(1202, { started_at: new Date(c.now()).toISOString() }));
    c.add(SYNC_INTERVAL_MS + 1);
    // Within the refresh window the old row is trusted; the new one is found by scan.
    let s = await syncActiveSessions(d, [STATION]);
    expect(s.sessions.map((x) => x.transactionId)).toEqual([1202, 1201]);
    c.add(REFRESH_AFTER_MS);
    s = await syncActiveSessions(d, [STATION]);
    expect(s.sessions.map((x) => x.transactionId)).toEqual([1202]);
    expect(
      (await endedSessions(d, STATION)).map((x) => x.transactionId),
    ).toEqual([1201]);
  });

  it("throttles scans per station and says so when Ivora fails", async () => {
    const a = api([...history(1200), running(1201)]);
    const { d } = deps(a);
    await syncActiveSessions(d, [STATION]);
    const calls = a.list.mock.calls.length;
    await syncActiveSessions(d, [STATION]);
    expect(a.list.mock.calls.length).toBe(calls);
    // A forced check (before a command) ignores the throttle and refuses a guess.
    a.list.mockRejectedValueOnce(new IvoraError(503, "unavailable", "down"));
    const f = await syncActiveSessions(d, [STATION], { fresh: true });
    expect(f.complete).toBe(false);
    expect(f.sessions.map((x) => x.transactionId)).toEqual([1201]);
  });
});

describe("stale and odd rows", () => {
  it("marks a session stalled after 12 hours without energy, and reads it less often", async () => {
    const c = clock();
    const a = api([running(1201)]);
    const { d } = deps(a, c.now);
    await syncActiveSessions(d, [STATION]);
    c.add(STALL_AFTER_MS + 1);
    await syncActiveSessions(d, [STATION]);
    const r = await loadLive(d, viewer);
    expect(r.ok && r.live.sessions.map((s) => [s.id, s.stalled])).toEqual([
      [1201, true],
    ]);
    a.read.mockClear();
    c.add(REFRESH_AFTER_MS + SYNC_INTERVAL_MS);
    await syncActiveSessions(d, [STATION]);
    expect(a.read).not.toHaveBeenCalled();
    c.add(STALLED_REFRESH_AFTER_MS);
    await syncActiveSessions(d, [STATION]);
    expect(a.read).toHaveBeenCalledTimes(1);
    // Energy again: no longer stalled.
    a.rows[0] = running(1201, { energy_wh: 2000 });
    c.add(STALLED_REFRESH_AFTER_MS);
    const s = await syncActiveSessions(d, [STATION]);
    const r2 = await loadLive(d, viewer);
    expect(s.sessions).toHaveLength(1);
    expect(r2.ok && r2.live.sessions[0].stalled).toBe(false);
  });

  it("drops a tracked session that Ivora answers 404 for", async () => {
    const c = clock();
    const a = api([running(1201)]);
    const { d, store } = deps(a, c.now);
    await syncActiveSessions(d, [STATION]);
    a.rows.length = 0;
    c.add(REFRESH_AFTER_MS);
    const s = await syncActiveSessions(d, [STATION]);
    expect(s.sessions).toEqual([]);
    expect(await store.getTrackedSession(1201)).toBeNull();
  });

  it("forgets the sessions of a station removed from Ivora", async () => {
    const a = api([running(1201)]);
    const store = bigStore();
    const { d } = deps(a, () => NOW, store);
    await store.trackSession({ ...trackedOf(running(5, { station_id: 99 })) });
    await loadLive(d, viewer);
    expect(await store.getTrackedSession(5)).toBeNull();
    expect(await store.getTrackedSession(1201)).not.toBeNull();
  });

  it("records an odd session with what it can, and the page still loads", async () => {
    const a = api([
      running(1201, {
        energy_wh: -5,
        connector_id: 0,
        started_at: "not a time",
        id_token: "x".repeat(60),
      }),
    ]);
    const { d, store } = deps(a);
    const r = await loadLive(d, viewer);
    expect(r.ok && r.live.counts.charging).toBe(1);
    expect(await store.getTrackedSession(1201)).toMatchObject({
      energyWh: null,
      connectorId: null,
      startedAt: null,
      idToken: null,
    });
  });
});

describe("the station page", () => {
  it("shows running and recently ended sessions of the station", async () => {
    const a = api([
      ...history(1200),
      running(1201),
      running(1202, { connector_id: 702, connector_number: 2 }),
    ]);
    const { d } = deps(a);
    const r = await loadStation(d, viewer, STATION);
    expect(r.ok && r.detail?.recent.map((x) => [x.id, x.active])).toEqual([
      [1202, true],
      [1201, true],
    ]);
    expect(r.ok && r.detail?.sessionsComplete).toBe(true);
    expect(r.ok && r.detail?.endedBefore).toBeNull();
  });
});

/** A transaction as the store records it. */
function trackedOf(t: Transaction) {
  return {
    transactionId: t.id,
    stationId: t.station_id!,
    connectorId: t.connector_id,
    connectorNumber: t.connector_number ?? null,
    idToken: t.id_token ?? null,
    startedAt: t.started_at,
    endedAt: t.ended_at,
    energyWh: t.energy_wh ?? null,
    active: t.active === true,
  };
}
