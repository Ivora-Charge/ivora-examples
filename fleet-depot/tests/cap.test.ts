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
import { MemoryStore } from "@/lib/store";
import type { Vehicle } from "@/lib/types";
import type { IvoraEvent } from "@/lib/webhook";
import { liveEnv } from "./support/fake-api";
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

describe("baseline profile (opt-in)", () => {
  const baselinePosts = (station: ReturnType<typeof fakeStation>) =>
    station.calls
      .filter(
        (c) => c.method === "POST" && c.url.endsWith("/charging-profiles"),
      )
      .map((c) => ({ url: c.url, body: JSON.parse(c.body!) }))
      .filter((c) => c.body.purpose === "tx_default");

  async function start(
    d: Depot,
    tx: number,
    stationId: number,
    connectorCount = 2,
    kwh = 40,
  ) {
    const v = vehicle(`v${tx}`, 8 + tx, kwh);
    await d.store.put("vehicles", v.id, v);
    await startSession(d, {
      vehicleId: v.id,
      stationId,
      protocol: "ocpp1.6",
      connectorId: 100 + tx,
      connectorKw: 11,
      connectorCount,
      transactionId: tx,
      meterStartWh: 0,
    });
  }

  it("is off by default: no tx_default profile is sent", async () => {
    const station = fakeStation({ protocol: "ocpp1.6" });
    connect(station);
    const d = depot(10);
    await start(d, 1, STATION);
    expect(baselinePosts(station)).toEqual([]);
    expect(await d.store.list("chargers")).toEqual([]);
  });

  it("sets each connector's share of the cap when a charger is added", async () => {
    const station = fakeStation({ protocol: "ocpp1.6" });
    connect(station);
    const d = depot(10, true);
    await start(d, 1, STATION, 2);
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

  it("follows a cap change, lower limits first", async () => {
    let fail = false;
    const station = fakeStation({
      protocol: "ocpp1.6",
      answer: (c) =>
        fail && JSON.parse(c.body!).purpose === "tx_default"
          ? "offline"
          : "accept",
    });
    connect(station);
    const d = depot(10, true);
    await start(d, 1, STATION, 2);
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

  it("a charger added later lowers the others first and starts within what is free", async () => {
    let failLower = false;
    const station = fakeStation({
      protocol: "ocpp1.6",
      answer: (c) =>
        failLower &&
        c.url.includes("/stations/12/") &&
        JSON.parse(c.body!).purpose === "tx_default"
          ? "offline"
          : "accept",
    });
    connect(station);
    const d = depot(10, true);
    await start(d, 1, 12, 1, 100); // takes the whole 10 kW
    expect(station.baselineW(12)).toBe(10000);
    failLower = true;
    await start(d, 2, 13, 1);
    const at = d.clock!.getTime();
    // The first vehicle keeps the whole cap; the new one starts at 0 W.
    expect(station.limitW(2, at, 13)).toBe(0);
    expect(
      (station.limitW(1, at, 12) ?? 0) + (station.limitW(2, at, 13) ?? 0),
    ).toBeLessThanOrEqual(10000);
    expect(station.baselineW(12)).toBe(10000); // the decrease has not landed
    failLower = false;
    await replan(d);
    expect(station.baselineW(12)).toBe(5000);
    await replan(d);
    expect(station.baselineW(13) ?? 0).toBeLessThanOrEqual(5000);
    expect(
      (station.limitW(1, at, 12) ?? 0) + (station.limitW(2, at, 13) ?? 0),
    ).toBeLessThanOrEqual(10000);
  });

  it("keeps room for idle connectors, so a plug-in stays under the cap", async () => {
    const station = fakeStation({ protocol: "ocpp1.6" });
    connect(station);
    const d = depot(10, true);
    await start(d, 1, STATION, 2); // one connector idle: 5 kW stays in reserve
    expect((await session(d, 1)).allocatedKw).toBeLessThanOrEqual(5);
    const at = d.clock!.getTime();
    // A second vehicle plugs in: it draws its 5 kW baseline until its profile is in force.
    expect(
      (station.limitW(1, at) ?? 0) + (station.baselineW(STATION) ?? 0),
    ).toBeLessThanOrEqual(10000);
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

/** True when no profile that may be in force is above what the plan now allows. */
async function settled(d: Depot, capW: number, units: number) {
  for (const s of await d.store.list("sessions"))
    if (s.sent?.some((p) => p.w > Math.round(s.allocatedKw * 1000)))
      return false;
  for (const c of await d.store.list("chargers"))
    if (c.sent?.some((p) => p.w > Math.floor(capW / units))) return false;
  return true;
}

describe("property: the station's limits never add up to more than the cap", () => {
  const ANSWERS: [Answer, number][] = [
    ["accept", 0.45],
    ["pending", 0.1],
    ["pending-later", 0.1],
    ["reject", 0.05],
    ["offline", 0.1],
    ["unknown-applied", 0.1],
    ["unknown-lost", 0.1],
  ];

  for (const protocol of ["ocpp1.6", "ocpp2.0.1"] as const)
    for (const baseline of [false, true])
      it(`holds at every request over random nights (${protocol}, baseline ${baseline ? "on" : "off"})`, async () => {
        for (let seed = 1; seed <= 25; seed++) {
          const r = rng(seed * (protocol === "ocpp1.6" ? 1 : 7919));
          const capKw = [7.4, 11, 22, 30][Math.floor(r() * 4)];
          const capW = Math.round(capKw * 1000);
          let healthy = false;
          const pick = (): Answer => {
            if (healthy) return "accept";
            let x = r();
            for (const [a, p] of ANSWERS) if ((x -= p) < 0) return a;
            return "accept";
          };
          const plugged = new Set<number>();
          let plugInChecks = 0;
          const d = depot(capKw, baseline);
          const check = (where: string) => {
            const at = d.clock!.getTime();
            let sum = 0;
            for (const tx of plugged) sum += station.limitW(tx, at) ?? 0;
            if (sum > capW)
              throw new Error(
                `seed ${seed} ${protocol}: ${sum} W > ${capW} W ${where}`,
              );
          };
          const station = fakeStation({
            protocol,
            answer: pick,
            onChange: () => check("during a request"),
          });
          connect(station);
          let nextTx = 1;

          for (let step = 0; step < 40; step++) {
            const x = r();
            const txs = [...plugged];
            if (x < 0.25 && plugged.size < 5) {
              const tx = nextTx++;
              const v = vehicle(
                `v${tx}`,
                (d.clock!.getTime() - T0) / H + 0.5 + r() * 12,
                5 + Math.floor(r() * 60),
              );
              await d.store.put("vehicles", v.id, v);
              // Until the charger applies a profile it runs at its own default,
              // outside the app's control: limitW() is undefined and not counted.
              plugged.add(tx);
              // The plug-in moment: the new transaction runs under the baseline (if any).
              // Not while a decrease is still on its way: the freed connector's share is
              // only safe once the lower limits are in force (the same rule as for
              // raises, see "decreases before increases").
              if (await settled(d, capW, 5)) {
                plugInChecks++;
                check("at plug-in");
              }
              await startSession(d, {
                vehicleId: v.id,
                stationId: STATION,
                protocol,
                connectorId: 100 + tx,
                connectorKw: [7.4, 11, 22][Math.floor(r() * 3)],
                connectorCount: 5,
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
            } else {
              d.clock = new Date(d.clock!.getTime() + r() * 2 * H);
              check("after time passed");
              await replan(d);
            }
            check(`after step ${step}`);
          }

          // The plug-in moment was really exercised, not skipped every time.
          expect(plugInChecks).toBeGreaterThan(0);

          // Once the station behaves, every allocation ends up in force.
          healthy = true;
          while (station.outbox.length > 0) {
            const m = station.deliver();
            await handleEvent(d, evt("charging_profile.accepted", m.id));
          }
          await replan(d);
          await replan(d);
          check("after recovery");
          const at = d.clock!.getTime();
          for (const s of await d.store.list("sessions")) {
            const allocW = Math.round(s.allocatedKw * 1000);
            expect(enforcedW(s.sent)).toBeLessThanOrEqual(allocW);
            expect(station.limitW(s.transactionId!, at)).toBeLessThanOrEqual(
              allocW,
            );
          }
        }
      });
});
