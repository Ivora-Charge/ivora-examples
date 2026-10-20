import { beforeAll, describe, expect, it } from "vitest";
import { createIvora, setIvora } from "@/lib/ivora";
import {
  endSession,
  enforcedW,
  replan,
  startSession,
  type Depot,
} from "@/lib/depot";
import { handleEvent } from "@/lib/events";
import { MemoryStore, type Docs, type Kind } from "@/lib/store";
import type { Charger, Vehicle } from "@/lib/types";
import type { IvoraEvent } from "@/lib/webhook";
import { liveEnv, type Call } from "./support/fake-api";
import { fakeStation, type Answer } from "./support/fake-station";

/**
 * The site cap in live mode, checked against what a fake station really applies:
 * lower limits go first, a raise waits until every lower limit is in force, and a
 * profile never expires into an unlimited charger.
 */

const T0 = Date.parse("2026-03-02T17:00:00Z");
const H = 3600_000;
const STATION = 12;

beforeAll(() => liveEnv());

function depot(capKw: number, baselineProfile = false): Depot {
  return {
    demo: false,
    store: new MemoryStore(),
    settings: {
      siteCapKw: capKw,
      centsPerKwh: 28,
      currency: "EUR",
      baselineProfile,
    },
    clock: new Date(T0),
  };
}

function connect(station: ReturnType<typeof fakeStation>) {
  setIvora(
    createIvora({
      baseUrl: "https://api.ivoracharge.com",
      apiKey: "iv_test_not_a_real_key",
      tenantId: "7",
      fetch: station.fetch,
      sleep: async () => {},
    }),
  );
}

const vehicle = (id: string, departH: number, kwh: number): Vehicle => ({
  id,
  name: id,
  plate: id,
  kind: "van",
  batteryKwh: 100,
  maxKw: 22,
  departure: new Date(T0 + departH * H).toISOString(),
  need: { kind: "kwh", kwh },
});

async function plugIn(d: Depot, v: Vehicle, tx: number, connectorKw = 11) {
  await d.store.put("vehicles", v.id, v);
  await startSession(d, {
    vehicleId: v.id,
    stationId: STATION,
    protocol: "ocpp1.6",
    connectorId: 100 + tx,
    connectorKw,
    transactionId: tx,
    meterStartWh: 0,
  });
}

const posts = (station: ReturnType<typeof fakeStation>, tx?: number) =>
  station.calls.filter(
    (c) =>
      c.method === "POST" &&
      c.url.endsWith("/charging-profiles") &&
      (tx === undefined || JSON.parse(c.body!).transaction_id === tx),
  );

const session = async (d: Depot, tx: number) =>
  (await d.store.list("sessions")).find((s) => s.transactionId === tx)!;

describe("decreases before increases", () => {
  // A departs first and takes the whole 10 kW; then its need drops, so A goes
  // down to 4 kW and B may go up to 6 kW.
  async function setup(answerForA: () => Answer) {
    let a: () => Answer = () => "accept";
    const station = fakeStation({
      protocol: "ocpp1.6",
      answer: (c) =>
        c.body && JSON.parse(c.body).transaction_id === 1 ? a() : "accept",
    });
    connect(station);
    const d = depot(10);
    await plugIn(d, vehicle("A", 2, 100), 1);
    await plugIn(d, vehicle("B", 8, 60), 2); // wants 7.5 kW
    expect((await session(d, 1)).allocatedKw).toBe(10);
    expect((await session(d, 2)).allocatedKw).toBe(0);
    a = answerForA;
    const before = posts(station, 2).length;
    await d.store.put("vehicles", "A", vehicle("A", 2, 8)); // 8 kWh in 2 h: 4 kW
    await replan(d);
    return { d, station, sentToB: () => posts(station, 2).length - before };
  }

  for (const failure of [
    "offline",
    "unknown-lost",
    "reject",
    "pending",
    "pending-later",
  ] as Answer[]) {
    it(`does not raise B while A's decrease is ${failure}`, async () => {
      const { d, station, sentToB } = await setup(() => failure);
      expect(sentToB()).toBe(0);
      expect((await session(d, 2)).allocatedKw).toBe(6);
      // The station still lets A draw its old 10 kW (or the new 4 kW), B its 0 kW.
      const at = d.clock!.getTime();
      expect(
        (station.limitW(1, at) ?? 0) + (station.limitW(2, at) ?? 0),
      ).toBeLessThanOrEqual(10000);
    });
  }

  it("raises B once A's lower limit is confirmed by webhook", async () => {
    const { d, station, sentToB } = await setup(() => "pending");
    expect(sentToB()).toBe(0);
    const m = station.deliver();
    await handleEvent(d, evt("charging_profile.accepted", m.id));
    expect(sentToB()).toBe(1);
    const lastA = posts(station, 1).at(-1)!;
    const firstB = posts(station, 2).at(-1)!;
    expect(station.calls.indexOf(lastA)).toBeLessThan(
      station.calls.indexOf(firstB),
    );
    expect(enforcedW((await session(d, 1)).sent)).toBe(4000);
  });

  it("retries the failed decrease on the next replan (timer), then raises", async () => {
    let fail = true;
    const { d, sentToB } = await setup(() => (fail ? "offline" : "accept"));
    expect(sentToB()).toBe(0);
    fail = false;
    await replan(d);
    expect(sentToB()).toBe(1);
    expect(enforcedW((await session(d, 2)).sent)).toBe(6000);
  });

  it("on OCPP 2.x keeps the old limit until the new one is accepted, then clears it", async () => {
    const station = fakeStation({ protocol: "ocpp2.0.1" });
    connect(station);
    const d = depot(10);
    await d.store.put("vehicles", "A", vehicle("A", 2, 100));
    await startSession(d, {
      vehicleId: "A",
      stationId: STATION,
      protocol: "ocpp2.0.1",
      connectorId: 101,
      connectorKw: 11,
      transactionId: 1,
      meterStartWh: 0,
    });
    await d.store.put("vehicles", "A", vehicle("A", 2, 8));
    await replan(d);
    const levels = posts(station).map((c) => JSON.parse(c.body!).stack_level);
    expect(levels).toEqual([1, 2]);
    const live = station.profiles.filter((p) => p.installed);
    expect(live.map((p) => p.stack)).toEqual([2]);
    expect(station.calls.some((c) => c.method === "DELETE")).toBe(true);
    // The DELETE came after the new profile was accepted.
    const del = station.calls.findIndex((c) => c.method === "DELETE");
    expect(del).toBeGreaterThan(station.calls.indexOf(posts(station)[1]));
    await d.store.put("vehicles", "A", vehicle("A", 2, 12));
    await replan(d);
    expect(posts(station).map((c) => JSON.parse(c.body!).stack_level)).toEqual([
      1, 2, 1,
    ]);
  });
});

describe("after departure", () => {
  it("a vehicle still plugged in keeps a capped profile with no expiry", async () => {
    const station = fakeStation({ protocol: "ocpp1.6" });
    connect(station);
    const d = depot(10);
    await plugIn(d, vehicle("A", 2, 60), 1);
    const first = JSON.parse(posts(station, 1)[0].body!);
    expect(first).not.toHaveProperty("duration_seconds");
    // Long after departure the station still applies the allocation, not "no limit".
    const later = T0 + 30 * H;
    expect(station.limitW(1, later)).toBe(10000);
    d.clock = new Date(later);
    await replan(d);
    const s = await session(d, 1);
    expect(s.allocatedKw).toBe(10);
    expect(station.limitW(1, later)).toBeLessThanOrEqual(10000);
  });
});

type Conns = { id: number; maxW: number | null }[];

/** `n` connectors on a station, IDs <station>1, <station>2, … */
const conns = (station: number, n: number, maxW: number | null = 11000) =>
  Array.from({ length: n }, (_, i) => ({ id: station * 10 + i + 1, maxW }));

/** A MemoryStore whose latest state the tests can read synchronously, mid-request. */
class SnoopStore extends MemoryStore {
  private docs = new Map<string, Map<string, unknown>>();
  put<K extends Kind>(kind: K, id: string, doc: Docs[K]) {
    if (!this.docs.has(kind)) this.docs.set(kind, new Map());
    this.docs.get(kind)!.set(id, structuredClone(doc));
    return super.put(kind, id, doc);
  }
  remove(kind: Kind, id: string) {
    this.docs.get(kind)?.delete(id);
    return super.remove(kind, id);
  }
  peek<K extends Kind>(kind: K): Docs[K][] {
    return [...(this.docs.get(kind)?.values() ?? [])] as Docs[K][];
  }
}

function snoopDepot(capKw: number, baselineProfile: boolean) {
  const d = depot(capKw, baselineProfile);
  const store = new SnoopStore();
  d.store = store;
  return { d, store };
}

const ratingOf = (c: Charger, connectorId?: number) => {
  const w = (x: Conns[number]) => x.maxW ?? 11000;
  const known = c.connectors.find((x) => x.id === connectorId);
  return known ? w(known) : Math.max(0, ...c.connectors.map(w));
};
const noBaseline = (c: Charger) =>
  c.refused !== undefined && !Number.isFinite(enforcedW(c.sent));

/**
 * Decreases not confirmed yet, W: how far what may still be in force, by the app's
 * own records, is above its plan. That includes a session's first profile, which
 * lowers it from the baseline it started under (or the charger's default) to its
 * allocation, and a baseline above its share on each idle connector it covers.
 */
function excessW(store: SnoopStore): number {
  const sessions = store.peek("sessions");
  const chargers = store.peek("chargers");
  const perConn = (c: Charger, id?: number) =>
    Math.min(enforcedW(c.sent), ratingOf(c, id));
  let x = 0;
  for (const s of sessions) {
    const c = chargers.find((y) => y.stationId === s.stationId);
    const own = enforcedW(s.sent);
    const may = Number.isFinite(own)
      ? own
      : Math.max(
          c ? (s.startBaselineW ?? ratingOf(c, s.connectorId)) : 0,
          ...(s.sent ?? []).map((p) => p.w),
        );
    x += Math.max(0, may - Math.round(s.allocatedKw * 1000));
  }
  for (const c of chargers)
    for (const k of c.connectors) {
      if (sessions.some((s) => s.connectorId === k.id)) continue;
      const planned = noBaseline(c)
        ? ratingOf(c, k.id)
        : Math.min(c.shareW ?? 0, ratingOf(c, k.id));
      x += Math.max(0, perConn(c, k.id) - planned);
    }
  return x;
}

/** Chargers without a baseline whose ratings alone exceed the cap: nothing can hold those. */
const beyondCapW = (store: SnoopStore, capW: number) =>
  Math.max(
    0,
    store
      .peek("chargers")
      .filter(noBaseline)
      .reduce(
        (sum, c) =>
          sum + c.connectors.reduce((n, k) => n + ratingOf(c, k.id), 0),
        0,
      ) - capW,
  );

describe("baseline profile (opt-in)", () => {
  const baselinePosts = (station: ReturnType<typeof fakeStation>) =>
    station.calls
      .filter(
        (c) => c.method === "POST" && c.url.endsWith("/charging-profiles"),
      )
      .map((c) => ({
        url: c.url,
        key: c.headers["idempotency-key"],
        body: JSON.parse(c.body!),
      }))
      .filter((c) => c.body.purpose === "tx_default");

  async function plug(
    d: Depot,
    st: ReturnType<typeof fakeStation>,
    stations: Record<number, Conns>,
    x: {
      tx: number;
      station: number;
      conn?: number;
      kwh?: number;
      departH?: number;
      maxKw?: number;
      known?: boolean;
      protocol?: "ocpp1.6" | "ocpp2.0.1";
    },
  ) {
    const v = {
      ...vehicle(`v${x.tx}`, x.departH ?? 8 + x.tx, x.kwh ?? 40),
      maxKw: x.maxKw ?? 22,
    };
    await d.store.put("vehicles", v.id, v);
    const c = stations[x.station][x.conn ?? 0];
    st.startTx(x.tx, x.station, c.id);
    await startSession(d, {
      vehicleId: v.id,
      stationId: x.station,
      protocol: x.protocol ?? "ocpp1.6",
      connectorId: c.id,
      connectorKw: c.maxW === null ? undefined : c.maxW / 1000,
      connectors: x.known === false ? undefined : stations[x.station],
      transactionId: x.tx,
      meterStartWh: 0,
    });
  }

  /** Every plugged transaction at its limit plus every idle connector at what a plug-in would draw. */
  function siteW(
    st: ReturnType<typeof fakeStation>,
    stations: Record<number, Conns>,
    plugged: Map<number, { station: number; conn: number }>,
    at: number,
  ) {
    let sum = 0;
    for (const [tx, p] of plugged) sum += st.limitW(tx, at, p.station)!;
    for (const [id, cs] of Object.entries(stations))
      for (const c of cs)
        if (![...plugged.values()].some((p) => p.conn === c.id))
          sum += st.idleW(Number(id), c.id);
    return sum;
  }

  it("is off by default: no tx_default profile is sent", async () => {
    const stations = { [STATION]: conns(STATION, 2) };
    const station = fakeStation({ protocol: "ocpp1.6", stations });
    connect(station);
    const d = depot(10);
    await plug(d, station, stations, { tx: 1, station: STATION });
    expect(baselinePosts(station)).toEqual([]);
    expect(await d.store.list("chargers")).toEqual([]);
  });

  it("sets each connector's share of the cap when a charger is added", async () => {
    const stations = { [STATION]: conns(STATION, 2) };
    const station = fakeStation({ protocol: "ocpp1.6", stations });
    connect(station);
    const d = depot(10, true);
    await plug(d, station, stations, { tx: 1, station: STATION });
    const [b] = baselinePosts(station);
    expect(b.body).toEqual({
      purpose: "tx_default",
      unit: "W",
      stack_level: 1,
      kind: "relative",
      periods: [{ start_offset_seconds: 0, limit: 5000 }],
    });
    expect(b.url).toContain(`/stations/${STATION}/charging-profiles`);
    expect(station.baselineW(STATION)).toBe(5000);
    // Nothing more is sent while nothing changes.
    const n = baselinePosts(station).length;
    await replan(d);
    expect(baselinePosts(station).length).toBe(n);
  });

  it("keys stay unique when the store is reset", async () => {
    const stations = { [STATION]: conns(STATION, 2) };
    const station = fakeStation({ protocol: "ocpp1.6", stations });
    connect(station);
    await plug(depot(10, true), station, stations, { tx: 1, station: STATION });
    await plug(depot(10, true), station, stations, { tx: 2, station: STATION });
    const keys = baselinePosts(station).map((b) => b.key);
    expect(keys).toHaveLength(2);
    for (const k of keys)
      expect(k).toMatch(new RegExp(`^fd-baseline-${STATION}-[0-9a-f-]{36}-1$`));
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("follows a cap change, lower limits first", async () => {
    let fail = false;
    const stations = { [STATION]: conns(STATION, 2) };
    const station = fakeStation({
      protocol: "ocpp1.6",
      stations,
      answer: (c) =>
        fail && JSON.parse(c.body!).purpose === "tx_default"
          ? "offline"
          : "accept",
    });
    connect(station);
    const d = depot(10, true);
    await plug(d, station, stations, { tx: 1, station: STATION });
    expect(station.baselineW(STATION)).toBe(5000);
    // The cap is raised while the charger is unreachable: nothing is raised.
    fail = true;
    d.settings.siteCapKw = 20;
    await replan(d);
    expect(station.baselineW(STATION)).toBe(5000);
    fail = false;
    await replan(d);
    expect(station.baselineW(STATION)).toBe(10000);
    // The cap is lowered: the baseline goes down at once.
    d.settings.siteCapKw = 6;
    await replan(d);
    expect(station.baselineW(STATION)).toBe(3000);
    // OCPP 1.6 replaced it at the same stack level, so one is in force.
    expect(
      station.profiles.filter((p) => p.purpose === "tx_default" && p.installed),
    ).toHaveLength(1);
  });

  it("a charger added later lowers the others first, then the new vehicle gets what is free", async () => {
    let failLower = false;
    const stations = { 12: conns(12, 1), 13: conns(13, 1) };
    const station = fakeStation({
      protocol: "ocpp1.6",
      stations,
      answer: (c) =>
        failLower &&
        c.url.includes("/stations/12/") &&
        JSON.parse(c.body!).purpose === "tx_default"
          ? "offline"
          : "accept",
    });
    connect(station);
    const d = depot(20, true);
    // Departs first and wants 11 kW; 9 kW of the 20 kW cap stay free.
    await plug(
      d,
      station,
      { 12: stations[12] },
      {
        tx: 1,
        station: 12,
        kwh: 99,
        departH: 9,
      },
    );
    expect(station.baselineW(12)).toBe(20000);
    failLower = true;
    await plug(d, station, stations, { tx: 2, station: 13, kwh: 100 });
    const at = d.clock!.getTime();
    // The second vehicle started under no baseline (the charger's 11 kW default):
    // the first plug-in on a charger is not covered. It is held to what is free.
    expect(station.limitW(1, at, 12)).toBe(11000);
    expect(station.limitW(2, at, 13)).toBe(9000);
    expect(station.baselineW(12)).toBe(20000); // the decrease has not landed
    failLower = false;
    await replan(d);
    expect(station.baselineW(12)).toBe(10000);
    expect(station.baselineW(13)).toBe(10000);
    expect(station.limitW(2, at, 13)).toBe(9000);
  });

  it("keeps room for idle connectors, so a plug-in stays under the cap", async () => {
    const stations = { [STATION]: conns(STATION, 2) };
    const station = fakeStation({ protocol: "ocpp1.6", stations });
    connect(station);
    const d = depot(10, true);
    await plug(d, station, stations, { tx: 1, station: STATION }); // one connector idle: 5 kW stays in reserve
    expect((await session(d, 1)).allocatedKw).toBeLessThanOrEqual(5);
    const at = d.clock!.getTime();
    // A second vehicle plugs in: it draws its 5 kW baseline until its profile is in force.
    expect(
      station.limitW(1, at)! + station.idleW(STATION, conns(STATION, 2)[1].id),
    ).toBeLessThanOrEqual(10000);
  });

  for (const protocol of ["ocpp1.6", "ocpp2.0.1"] as const)
    it(`a cap raise never lets the idle reserve go stale (${protocol})`, async () => {
      // Three one-connector chargers; one vehicle wants 30 kW. The cap goes from 33
      // to 66 kW: 22 kW per connector, so the vehicle may have 22 kW.
      const stations = {
        31: conns(31, 1, 50000),
        32: conns(32, 1, 22000),
        33: conns(33, 1, 22000),
      };
      const plugged = new Map<number, { station: number; conn: number }>();
      let watch = false;
      let worst = 0;
      const station = fakeStation({
        protocol,
        stations,
        onChange: () => {
          if (watch)
            worst = Math.max(
              worst,
              siteW(station, stations, plugged, d.clock!.getTime()),
            );
        },
      });
      connect(station);
      const d = depot(33, true);
      // Earlier visits made the depot know chargers 32 and 33.
      await plug(d, station, stations, { tx: 1, station: 32, protocol });
      await plug(d, station, stations, { tx: 2, station: 33, protocol });
      for (const tx of [1, 2]) {
        station.endTx(tx);
        await endSession(d, `tx-${tx}`);
      }
      plugged.set(3, { station: 31, conn: 311 });
      await plug(d, station, stations, {
        tx: 3,
        station: 31,
        kwh: 60,
        departH: 2,
        maxKw: 50,
        protocol,
      });
      const at = d.clock!.getTime();
      expect(siteW(station, stations, plugged, at)).toBeLessThanOrEqual(33000);
      watch = true;
      d.settings.siteCapKw = 66;
      await replan(d);
      watch = false;
      expect(worst).toBeLessThanOrEqual(66000);
      expect(siteW(station, stations, plugged, at)).toBeLessThanOrEqual(66000);
      expect(station.limitW(3, at)).toBe(22000);
      expect(station.baselineW(32)).toBe(22000);
      expect(station.baselineW(33)).toBe(22000);
    });

  for (const refusal of ["reject", "unsupported"] as const)
    it(`a charger that ${refusal === "reject" ? "rejects" : "does not support"} its baseline is reserved at its rating and blocks nothing`, async () => {
      const stations = { 41: conns(41, 1), 42: conns(42, 2, 22000) };
      const station = fakeStation({
        protocol: "ocpp1.6",
        stations,
        answer: (c) =>
          c.url.includes("/stations/41/") &&
          JSON.parse(c.body!).purpose === "tx_default"
            ? refusal
            : "accept",
      });
      connect(station);
      const d = depot(33, true);
      // An earlier visit made the depot know station 41, which refused its baseline.
      await plug(d, station, stations, { tx: 1, station: 41 });
      station.endTx(1);
      await endSession(d, "tx-1");
      const tries = () =>
        baselinePosts(station).filter((b) => b.url.includes("/stations/41/"))
          .length;
      expect(tries()).toBe(1);
      const c41 = (await d.store.list("chargers")).find(
        (c) => c.stationId === 41,
      )!;
      expect(c41.refused).toBeDefined();
      // A departs first and takes 22 kW; B gets nothing: 33 kW minus 11 kW kept for
      // station 41's idle connector at its rating.
      await plug(d, station, stations, {
        tx: 2,
        station: 42,
        kwh: 100,
        departH: 1,
      });
      await plug(d, station, stations, {
        tx: 3,
        station: 42,
        conn: 1,
        kwh: 100,
        departH: 9,
      });
      const at = d.clock!.getTime();
      expect(station.limitW(3, at, 42)).toBe(0);
      const before = tries();
      // A leaves: B may have what A's connector does not keep for its baseline.
      station.endTx(2);
      await endSession(d, "tx-2");
      expect((await session(d, 3)).allocatedKw).toBe(11);
      expect(station.limitW(3, at, 42)).toBe(11000);
      expect(station.baselineW(42)).toBe(11000);
      expect(
        station.limitW(3, at, 42)! +
          station.idleW(41, 411) +
          station.idleW(42, 421),
      ).toBeLessThanOrEqual(33000);
      // Not sent again on every replan, and no raise waits for it.
      for (let i = 0; i < 3; i++) await replan(d);
      expect(tries()).toBe(before);
      const events = await d.store.list("events");
      expect(events.filter((e) => e.type === "plan.deferred")).toEqual([]);
      // A new plan (the cap changes) tries it once more.
      d.settings.siteCapKw = 30;
      await replan(d);
      await replan(d);
      expect(tries()).toBe(before + 1);
      // And so does the passing of an hour, once.
      d.clock = new Date(d.clock!.getTime() + 59 * 60_000);
      await replan(d);
      expect(tries()).toBe(before + 1);
      d.clock = new Date(d.clock!.getTime() + 2 * 60_000);
      await replan(d);
      await replan(d);
      expect(tries()).toBe(before + 2);
    });

  for (const protocol of ["ocpp1.6", "ocpp2.0.1"] as const)
    it(`a baseline is not raised above a lower one still unanswered (${protocol})`, async () => {
      // The charger applied the 2 kW baseline but its answer has not arrived. Going
      // back up to 5 kW is a raise at the charger, though the app still counts 11 kW.
      let answer: Answer = "accept";
      const stations = { 71: conns(71, 2) };
      const station = fakeStation({ protocol, stations, answer: () => answer });
      connect(station);
      const d = depot(22, true);
      await plug(d, station, stations, { tx: 1, station: 71, protocol });
      station.endTx(1);
      await endSession(d, "tx-1");
      expect(station.baselineW(71)).toBe(11000);
      answer = "pending";
      d.settings.siteCapKw = 4;
      await replan(d);
      expect(station.baselineW(71)).toBe(2000);
      answer = "accept";
      const sent = baselinePosts(station).length;
      d.settings.siteCapKw = 10;
      await replan(d);
      expect(baselinePosts(station).length).toBe(sent);
      expect(station.baselineW(71)).toBe(2000);
      // Once the charger's answer arrives, the raise follows.
      const m = station.deliver();
      await handleEvent(d, evt("charging_profile.accepted", m.id));
      expect(station.baselineW(71)).toBe(5000);
    });

  for (const protocol of ["ocpp1.6", "ocpp2.0.1"] as const)
    it(`a charger that was offline once is not treated as refusing (${protocol})`, async () => {
      // The API reports an offline station as a rejected operation (station_offline):
      // the charger never saw the profile, so it is sent again once the station is back.
      let offline = true;
      const stations = { 81: conns(81, 2), 82: conns(82, 1) };
      const station = fakeStation({
        protocol,
        stations,
        answer: (c) =>
          offline && c.url.includes("/stations/81/")
            ? "offline-rejected"
            : "accept",
      });
      connect(station);
      const d = depot(22, true);
      await plug(d, station, stations, { tx: 1, station: 81, protocol });
      station.endTx(1);
      await endSession(d, "tx-1");
      expect(station.baselineW(81)).toBeUndefined();
      const [c81] = await d.store.list("chargers");
      expect(c81.refused).toBeUndefined();
      offline = false;
      await plug(d, station, stations, {
        tx: 2,
        station: 82,
        kwh: 100,
        departH: 2,
        protocol,
      });
      for (let i = 0; i < 5; i++) await replan(d);
      const events = await d.store.list("events");
      expect(events.filter((e) => e.type.endsWith("baseline_refused"))).toEqual(
        [],
      );
      // 22 kW over three connectors.
      expect(station.baselineW(81)).toBe(7333);
      expect(station.baselineW(82)).toBe(7333);
      const at = d.clock!.getTime();
      expect(station.limitW(2, at, 82)).toBe(7334);
      expect(
        station.limitW(2, at, 82)! +
          station.idleW(81, 811) +
          station.idleW(81, 812),
      ).toBeLessThanOrEqual(22000);
    });

  for (const protocol of ["ocpp1.6", "ocpp2.0.1"] as const)
    it(`a new vehicle is held to what idle connectors leave free while their baseline is above its share (${protocol})`, async () => {
      // Station 91 is known and keeps 22 kW for its idle connector. A vehicle plugs
      // into a new station 92: the share drops to 11 kW, but 91 cannot be reached, so
      // its idle connector may still draw 22 kW and the vehicle gets nothing yet.
      let offline = false;
      const stations = { 91: conns(91, 1, 22000), 92: conns(92, 1, 22000) };
      const plugged = new Map<number, { station: number; conn: number }>();
      const station = fakeStation({
        protocol,
        stations,
        answer: (c) =>
          offline && c.url.includes("/stations/91/") ? "offline" : "accept",
      });
      connect(station);
      const d = depot(22, true);
      await plug(
        d,
        station,
        { 91: stations[91] },
        { tx: 1, station: 91, protocol },
      );
      station.endTx(1);
      await endSession(d, "tx-1");
      expect(station.baselineW(91)).toBe(22000);
      offline = true;
      plugged.set(2, { station: 92, conn: 921 });
      await plug(d, station, stations, {
        tx: 2,
        station: 92,
        kwh: 100,
        departH: 2,
        protocol,
      });
      const at = d.clock!.getTime();
      expect(station.ownLimitW(2, at)).toBe(0);
      expect(siteW(station, stations, plugged, at)).toBeLessThanOrEqual(22000);
      offline = false;
      await replan(d);
      expect(station.baselineW(91)).toBe(11000);
      expect(station.ownLimitW(2, at)).toBe(11000);
      expect(siteW(station, stations, plugged, at)).toBeLessThanOrEqual(22000);
    });

  it("does not add a charger until its connectors are known, and retries the lookup", async () => {
    // Two 22 kW connectors under a 22 kW cap: counting one would let a second
    // vehicle start at a 22 kW baseline next to a 22 kW session.
    const stations = { 51: conns(51, 2, 22000) };
    let lookup = false;
    const station = fakeStation({
      protocol: "ocpp1.6",
      stations,
      stationLookup: () => lookup,
    });
    connect(station);
    const d = depot(22, true);
    await plug(d, station, stations, {
      tx: 1,
      station: 51,
      kwh: 100,
      departH: 4,
      known: false,
    });
    expect(await d.store.list("chargers")).toEqual([]);
    expect(baselinePosts(station)).toEqual([]);
    expect(
      (await d.store.list("events")).some((e) =>
        e.detail.includes("connectors unknown"),
      ),
    ).toBe(true);
    // A station that keeps failing is logged once an hour, not on every replan.
    const logged = async () =>
      (await d.store.list("events")).filter((e) =>
        e.detail.includes("connectors unknown"),
      ).length;
    for (let i = 0; i < 3; i++) await replan(d);
    expect(await logged()).toBe(1);
    d.clock = new Date(d.clock!.getTime() + H);
    await replan(d);
    expect(await logged()).toBe(2);
    lookup = true;
    await replan(d);
    const [c] = await d.store.list("chargers");
    expect(c.connectors).toHaveLength(2);
    expect(station.baselineW(51)).toBe(11000);
    const at = d.clock!.getTime();
    expect(station.limitW(1, at, 51)).toBe(11000);
    // The second vehicle plugs in: at most its 11 kW baseline next to the first.
    expect(station.limitW(1, at, 51)! + station.idleW(51, 512)).toBe(22000);
  });
});

const evt = (type: string, profileId: string): IvoraEvent => ({
  id: `evt_${Math.random()}`,
  type,
  tenant_id: 7,
  data: { profile: { id: profileId }, station_id: STATION },
});

/** A small seeded PRNG, so a failing scenario can be replayed. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property: the station's limits never add up to more than the cap", () => {
  const ANSWERS: [Answer, number][] = [
    ["accept", 0.45],
    ["pending", 0.1],
    ["pending-later", 0.1],
    ["reject", 0.05],
    ["offline", 0.05],
    ["offline-rejected", 0.05],
    ["unknown-applied", 0.1],
    ["unknown-lost", 0.1],
  ];
  const RATINGS = [7400, 11000, 22000, null];

  for (const protocol of ["ocpp1.6", "ocpp2.0.1"] as const)
    for (const baseline of [false, true])
      it(`holds at every request over random nights (${protocol}, baseline ${baseline ? "on" : "off"})`, async () => {
        for (let seed = 1; seed <= 25; seed++) {
          let plugInChecks = 0;
          const r = rng(seed * (protocol === "ocpp1.6" ? 1 : 7919));
          const CAPS = [7.4, 11, 22, 30];
          const capKw = CAPS[Math.floor(r() * CAPS.length)];
          let capW = Math.round(capKw * 1000);
          let oldCapW = 0;
          // Stations with one, two and three connectors.
          const stations: Record<number, Conns> = {};
          [1, 2, 3].forEach((n, i) => {
            const id = 61 + i;
            stations[id] = conns(id, n).map((c) => ({
              ...c,
              maxW: RATINGS[Math.floor(r() * RATINGS.length)],
            }));
          });
          let healthy = false;
          const pick = (c: Call): Answer => {
            if (healthy) return "accept";
            // Now and then a charger does not support baselines at all.
            if (c.body && JSON.parse(c.body).purpose === "tx_default")
              if (r() < 0.04) return "unsupported";
            let x = r();
            for (const [a, p] of ANSWERS) if ((x -= p) < 0) return a;
            return "accept";
          };
          /** Plugged transactions: station and connector. */
          const plugged = new Map<
            number,
            { station: number; conn: number; covered: boolean }
          >();
          const { d, store } = snoopDepot(capKw, baseline);
          const known = (id: number) =>
            store.peek("chargers").some((c) => c.stationId === id);
          /**
           * What the stations let every plugged vehicle draw, plus (baseline on) what
           * a vehicle plugging into each idle connector of a charger the app knows
           * would draw. Before its own profile is in force a transaction runs under
           * the baseline it started with, or the charger's default: counted when the
           * app knew that charger at plug-in (with the baseline off, or on a charger
           * the app had not seen yet, that first moment is outside its control).
           */
          const siteNow = () => {
            const at = d.clock!.getTime();
            let sum = 0;
            for (const [tx, p] of plugged)
              sum +=
                station.ownLimitW(tx, at) ??
                (p.covered ? station.limitW(tx, at, p.station)! : 0);
            if (baseline)
              for (const [id, cs] of Object.entries(stations)) {
                if (!known(Number(id))) continue;
                for (const c of cs)
                  if (![...plugged.values()].some((p) => p.conn === c.id))
                    sum += station.idleW(Number(id), c.id);
              }
            return sum;
          };
          /**
           * The worst case by the stations' own state, W: every plugged vehicle at its
           * own limit or what it started under (when covered), every idle connector
           * of a known charger at its baseline or rating, profiles not acted on yet
           * included. `skipTx` leaves one transaction out.
           */
          /**
           * A failed check. Thrown inside a request the app would take it for a
           * network error and carry on, so it is also kept and rethrown after the step.
           */
          let violation: string | undefined;
          const fail = (msg: string) => {
            violation ??= msg;
            throw new Error(msg);
          };
          const stationWorst = (skipTx?: number) => {
            let sum = 0;
            for (const [tx, p] of plugged)
              if (tx !== skipTx) sum += station.worstTxW(tx, p.covered);
            if (baseline)
              for (const [id, cs] of Object.entries(stations)) {
                if (!known(Number(id))) continue;
                for (const c of cs)
                  if (![...plugged.values()].some((p) => p.conn === c.id))
                    sum += station.worstIdleW(Number(id), c.id);
              }
            return sum;
          };
          /**
           * Every new limit is sized against what the rest of the site may draw at
           * that moment, by the stations' state (not the app's records): a session
           * profile never above the cap minus everything else, and a baseline raise
           * only when the whole site stays within the cap with it. Resends of an
           * earlier request (same key) were sized when first sent.
           */
          const seen = new Set<string>();
          let raise: { station: number; beforeW?: number } | undefined;
          const sized = (c: Call, when: "before" | "after") => {
            if (c.method !== "POST" || !c.url.endsWith("/charging-profiles"))
              return;
            const key = c.headers["idempotency-key"];
            if (when === "before") {
              raise = undefined;
              if (seen.has(key)) return;
            } else if (seen.has(key)) return;
            const body = JSON.parse(c.body!);
            const w = Math.max(
              ...body.periods.map((p: { limit: number }) => p.limit),
            );
            if (body.purpose === "tx_default") {
              const sid = Number(c.url.match(/\/stations\/(\d+)\//)![1]);
              if (when === "before")
                raise = { station: sid, beforeW: station.worstBaselineW(sid) };
              else {
                seen.add(key);
                const was = raise?.beforeW;
                if (was !== undefined && w > was) {
                  const sum = stationWorst();
                  const bound = capW + beyondCapW(store, capW);
                  if (sum > bound)
                    fail(
                      `seed ${seed} ${protocol}: baseline raised to ${w} W at station ${sid} with the site at ${sum} W > ${bound} W`,
                    );
                }
              }
            } else if (when === "before") {
              const others = stationWorst(body.transaction_id);
              if (w > Math.max(0, capW - others))
                fail(
                  `seed ${seed} ${protocol}: tx ${body.transaction_id} sent ${w} W with the rest of the site at ${others} W (cap ${capW} W)`,
                );
            } else seen.add(key);
          };
          const check = (where: string) => {
            const sum = siteNow();
            // The cap plus decreases still on their way (after a lower cap, or a
            // freed connector's share, which is only safe once they land). `sized`
            // checks that nothing is raised into that excess.
            const bound =
              Math.max(capW, oldCapW) +
              excessW(store) +
              beyondCapW(store, capW);
            if (sum > bound)
              fail(
                `seed ${seed} ${protocol}: ${sum} W > ${bound} W (cap ${capW} W) ${where}`,
              );
          };
          const station = fakeStation({
            protocol,
            stations,
            answer: pick,
            stationLookup: () => healthy || r() > 0.3,
            beforeRequest: (c) => sized(c, "before"),
            onChange: (c) => {
              sized(c, "after");
              check("during a request");
            },
          });
          connect(station);
          let nextTx = 1;

          for (let step = 0; step < 40; step++) {
            const x = r();
            const txs = [...plugged.keys()];
            const free = Object.entries(stations).flatMap(([id, cs]) =>
              cs
                .filter(
                  (c) => ![...plugged.values()].some((p) => p.conn === c.id),
                )
                .map((c) => ({ station: Number(id), c })),
            );
            if (x < 0.25 && free.length > 0) {
              const tx = nextTx++;
              const { station: sid, c } = free[Math.floor(r() * free.length)];
              const v = vehicle(
                `v${tx}`,
                (d.clock!.getTime() - T0) / H + 0.5 + r() * 12,
                5 + Math.floor(r() * 60),
              );
              await d.store.put("vehicles", v.id, v);
              // The plug-in moment: the new transaction runs under the baseline in
              // force (or the charger's default) until its own profile is.
              station.startTx(tx, sid, c.id);
              const covered = baseline && known(sid);
              plugged.set(tx, { station: sid, conn: c.id, covered });
              if (covered) plugInChecks++;
              check("at plug-in");
              await startSession(d, {
                vehicleId: v.id,
                stationId: sid,
                protocol,
                connectorId: c.id,
                connectorKw: c.maxW === null ? undefined : c.maxW / 1000,
                // Sometimes the station could not be read when the session started.
                connectors: r() < 0.7 ? stations[sid] : undefined,
                transactionId: tx,
                meterStartWh: 0,
              });
            } else if (x < 0.4 && txs.length > 0) {
              const tx = txs[Math.floor(r() * txs.length)];
              station.endTx(tx);
              plugged.delete(tx);
              await endSession(d, `tx-${tx}`);
            } else if (x < 0.55 && txs.length > 0) {
              const tx = txs[Math.floor(r() * txs.length)];
              const v = vehicle(
                `v${tx}`,
                (d.clock!.getTime() - T0) / H - 1 + r() * 10,
                Math.floor(r() * 50),
              );
              await d.store.put("vehicles", v.id, v);
              await replan(d);
            } else if (x < 0.75 && station.outbox.length > 0) {
              const m = station.deliver(
                Math.floor(r() * station.outbox.length),
              );
              await handleEvent(d, evt("charging_profile.accepted", m.id));
            } else if (x < 0.8) {
              // The operator changes the cap: every share moves, and a lower one
              // leaves baselines above it until the decrease lands.
              // Until the replan has split the new cap, the old allocations stand.
              oldCapW = capW;
              d.settings.siteCapKw = CAPS[Math.floor(r() * CAPS.length)];
              capW = Math.round(d.settings.siteCapKw * 1000);
              await replan(d);
              oldCapW = 0;
            } else {
              d.clock = new Date(d.clock!.getTime() + r() * 2 * H);
              check("after time passed");
              await replan(d);
            }
            check(`after step ${step}`);
            if (violation) throw new Error(violation);
          }

          // Once the station behaves, every allocation ends up in force.
          healthy = true;
          while (station.outbox.length > 0) {
            const m = station.deliver();
            await handleEvent(d, evt("charging_profile.accepted", m.id));
          }
          for (let i = 0; i < 3; i++) await replan(d);
          check("after recovery");
          if (violation) throw new Error(violation);
          const at = d.clock!.getTime();
          for (const s of await d.store.list("sessions")) {
            const allocW = Math.round(s.allocatedKw * 1000);
            expect(enforcedW(s.sent)).toBeLessThanOrEqual(allocW);
            expect(
              station.limitW(s.transactionId!, at, s.stationId),
            ).toBeLessThanOrEqual(allocW);
          }
          if (baseline) {
            // Nothing is on its way any more, and the worst case (every plugged
            // vehicle at its limit, every idle connector of every known charger at
            // its baseline or rating) is within the cap.
            expect(excessW(store)).toBe(0);
            expect(siteNow()).toBeLessThanOrEqual(
              capW + beyondCapW(store, capW),
            );
            // The plug-in moment on a known charger was really exercised.
            if (plugInChecks === 0)
              throw new Error(`seed ${seed} ${protocol}: no covered plug-in`);
          }
        }
      });
});
