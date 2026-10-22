import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IvoraError } from "@/lib/server/ivora/errors";
import type {
  IvoraClient,
  Station,
  Transaction,
} from "@/lib/server/ivora/types";
import {
  REFRESH_AFTER_MS,
  resetActiveSyncForTests,
  SYNC_INTERVAL_MS,
  syncActiveSessions,
} from "@/lib/server/live/active";
import { createDemoLiveStore, memoryDemoLive } from "@/lib/server/live/demo";
import {
  handleEvent,
  loadLive,
  loadStation,
  type IvoraEvent,
  type LiveDeps,
} from "@/lib/server/live/service";
import {
  SEED_MARGIN,
  scanNewTransactions,
} from "@/lib/server/live/transactions";
import type { Staff } from "@/lib/server/team/types";

// The Live view's running sessions against an API-shaped fake of Ivora: GET
// /transactions lists oldest first, pages with `after`, and its items carry no ID token
// or connector; GET /transactions/{id} has them.

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
const history = (n: number, station = STATION) =>
  Array.from({ length: n }, (_, i) => tx(i + 1, { station_id: station }));

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
      return {
        data,
        next_cursor: all.length > data.length ? data[data.length - 1].id : null,
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

function deps(a: ReturnType<typeof api>, now = () => NOW) {
  const store = createDemoLiveStore(memoryDemoLive());
  const d: LiveDeps = { store, ivora: a.ivora, now, sleep: async () => {} };
  return { d, store };
}

beforeEach(() => {
  resetActiveSyncForTests();
  // The demo store stamps checkedAt with the wall clock; keep it on the test clock.
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
    // Old sessions were passed over by their list item, never read in full.
    expect(a.read.mock.calls.map((c) => c[0]).sort()).toEqual([1201, 1202]);
  });

  it("rebuilds on a cold start, then pages on from the stored mark, not from 0", async () => {
    const a = api([...history(1200), running(1201)]);
    const { d, store } = deps(a);
    await syncActiveSessions(d, [STATION]);
    expect(await store.getTrackerMark(STATION)).toBe(1201);
    // Another instance, a minute later: same tables, no throttle state.
    resetActiveSyncForTests();
    a.list.mockClear();
    a.rows.push(running(1202, { connector_id: 702 }));
    const later = deps(a, () => NOW + 60_000);
    later.d.store = store;
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
      60 + Math.ceil(SEED_MARGIN / 100) + 2,
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
        ...history(5, 71).map((t) => ({ ...t, id: t.id + 5000 })),
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

describe("webhooks and gaps", () => {
  const event = (type: string, data: Record<string, unknown>): IvoraEvent => ({
    id: `evt_${Math.random()}`,
    type,
    tenant_id: 42,
    station_id: STATION,
    data,
  });

  it("tracks a session from its webhook and ends it on the ended event, for good", async () => {
    const a = api([...history(1200), running(1201)]);
    const { d, store } = deps(a);
    // Mark the station scanned so only the webhook can have found the session.
    await store.advanceTrackerMark(STATION, 1201);
    await handleEvent(
      { ...d },
      event("charging_session.status_changed", { transaction_id: 1201 }),
    ).catch(() => undefined);
    expect(
      (await store.listTrackedSessions()).map((t) => t.transactionId),
    ).toEqual([1201]);
    // Ended in Ivora; its ended event arrives.
    a.rows[1200] = tx(1201, { ended_at: new Date(NOW).toISOString() });
    await handleEvent(
      d,
      event("charging_session.status_changed", { transaction_id: 1201 }),
    );
    expect(await store.listTrackedSessions()).toEqual([]);
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
    expect(await store.listTrackedSessions()).toEqual([]);
    expect((await store.listTrackedSessions({ ended: true })).length).toBe(1);
  });

  it("falls back to the transaction named by resource_id on a session event", async () => {
    const a = api([running(1201)]);
    const { d, store } = deps(a);
    await handleEvent(d, {
      ...event("charging_session.status_changed", {}),
      resource_id: "1201",
    });
    expect((await store.listTrackedSessions()).length).toBe(1);
  });

  it("ignores an event for a transaction of another station", async () => {
    const a = api([running(1201, { station_id: 99 })]);
    const { d, store } = deps(a);
    await handleEvent(d, event("meter.sampled", { transaction_id: 1201 }));
    expect(await store.listTrackedSessions()).toEqual([]);
  });

  it("repairs a webhook gap: finds a missed start by scanning and a missed end by re-reading", async () => {
    let now = NOW;
    const a = api([...history(1200), running(1201)]);
    const { d } = deps(a, () => now);
    expect((await syncActiveSessions(d, [STATION])).sessions).toHaveLength(1);
    // No webhook arrives for either change.
    a.rows[1200] = tx(1201, { ended_at: new Date(now).toISOString() });
    a.rows.push(running(1202, { started_at: new Date(now).toISOString() }));
    now += SYNC_INTERVAL_MS + 1;
    vi.setSystemTime(now);
    // Within the refresh window the old row is trusted; the new one is found by scan.
    let s = await syncActiveSessions(d, [STATION]);
    expect(s.sessions.map((x) => x.transactionId)).toEqual([1202, 1201]);
    now += REFRESH_AFTER_MS;
    vi.setSystemTime(now);
    s = await syncActiveSessions(d, [STATION]);
    expect(s.sessions.map((x) => x.transactionId)).toEqual([1202]);
    expect(s.ended.map((x) => x.transactionId)).toEqual([1201]);
  });

  it("throttles scans per station and says so when Ivora fails", async () => {
    const a = api([...history(1200), running(1201)]);
    const { d } = deps(a);
    await syncActiveSessions(d, [STATION]);
    const calls = a.list.mock.calls.length;
    await syncActiveSessions(d, [STATION]);
    expect(a.list.mock.calls.length).toBe(calls);
    // A forced check (before a command) ignores the throttle and refuses a guess.
    a.list.mockRejectedValueOnce(new IvoraError(429, "rate_limited", "slow"));
    const f = await syncActiveSessions(d, [STATION], { fresh: true });
    expect(f.complete).toBe(false);
    expect(f.sessions.map((x) => x.transactionId)).toEqual([1201]);
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
  });
});
