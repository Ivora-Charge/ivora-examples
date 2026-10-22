import type { Depot } from "./depot";
import { endSession, logEvent, replan, startSession } from "./depot";
import type { Driver, Vehicle } from "./types";
import { energyNeededKwh, whToKwh } from "./units";

/** Demo site limit, kW. Live mode keeps SITE_CAP_KW. */
export const DEMO_CAP_KW = 150;

/** Demo tariff: a flat depot rate in US dollars. Live mode keeps TARIFF_*. */
export const DEMO_CURRENCY = "USD";
export const DEMO_CENTS_PER_KWH = 18;

/** A charge point. A dual-outlet AC unit has two outlets, each at the rated power. */
interface Charger {
  id: number;
  name: string;
  type: "L2 AC" | "DC fast";
  kw: number;
  outlets: number;
}
export const CHARGERS: Charger[] = [
  { id: 1, name: "AC-1", type: "L2 AC", kw: 19.2, outlets: 2 },
  { id: 2, name: "AC-2", type: "L2 AC", kw: 11, outlets: 2 },
  { id: 3, name: "AC-3", type: "L2 AC", kw: 11, outlets: 2 },
  { id: 4, name: "AC-4", type: "L2 AC", kw: 11, outlets: 2 },
  { id: 5, name: "AC-5", type: "L2 AC", kw: 11, outlets: 1 },
  { id: 6, name: "AC-6", type: "L2 AC", kw: 11, outlets: 1 },
  { id: 7, name: "DC-1", type: "DC fast", kw: 60, outlets: 1 },
  { id: 8, name: "DC-2", type: "DC fast", kw: 60, outlets: 1 },
];

/** Made-up names. Card values are invented and carry no real format. */
const DRIVERS = [
  "Avery Stone",
  "Jordan Lee",
  "Sam Okafor",
  "Riley Park",
  "Casey Moreno",
  "Morgan Diaz",
  "Taylor Brandt",
  "Quinn Abara",
  "Devon Hale",
  "Robin Castell",
  "Jamie Novak",
  "Alex Ferro",
  // Relief drivers: they take a shared van on some days in the history.
  "Kai Lindqvist",
  "Noor Haddad",
];

interface Plan {
  name: string;
  plate: string;
  kind: Vehicle["kind"];
  batteryKwh: number;
  maxKw: number;
  charger: number;
  outlet: number;
  /** Hours after midnight on the demo day. */
  arrive: number;
  /** Hours after midnight on the next morning. */
  depart: number;
  socPercent: number;
  targetPercent: number;
  /** Index into DRIVERS, one vehicle each; `alt` is a relief driver who takes it on some days in the history. */
  driver: number;
  alt?: number;
}
// 12 vehicles on 8 chargers (6 L2 AC, 2 DC), 12 outlets: mostly 11 kW, one 19.2 kW dual unit, two 60 kW DC.
// Arrival charge varies (15-50%); the last van is the scripted at-risk one and arrives nearly empty.
const PLANS: Plan[] = [
  {
    name: "Shuttle bus 1",
    plate: "DEMO-B1",
    kind: "bus",
    batteryKwh: 400,
    maxKw: 60,
    charger: 7,
    outlet: 1,
    arrive: 21,
    depart: 5.5,
    socPercent: 8,
    targetPercent: 100,
    driver: 0,
  },
  {
    name: "Box truck 1",
    plate: "DEMO-T1",
    kind: "truck",
    batteryKwh: 400,
    maxKw: 60,
    charger: 8,
    outlet: 1,
    arrive: 21,
    depart: 5.5,
    socPercent: 10,
    targetPercent: 100,
    driver: 1,
  },
  {
    name: "Delivery van XL 1",
    plate: "DEMO-X1",
    kind: "van",
    batteryKwh: 135,
    maxKw: 19.2,
    charger: 1,
    outlet: 1,
    arrive: 19,
    depart: 5.5,
    socPercent: 20,
    targetPercent: 100,
    driver: 2,
  },
  {
    name: "Delivery van XL 2",
    plate: "DEMO-X2",
    kind: "van",
    batteryKwh: 135,
    maxKw: 11,
    charger: 3,
    outlet: 1,
    arrive: 20.5,
    depart: 5.75,
    socPercent: 25,
    targetPercent: 100,
    driver: 3,
  },
  {
    name: "Cargo van 1",
    plate: "DEMO-C1",
    kind: "van",
    batteryKwh: 89,
    maxKw: 11,
    charger: 2,
    outlet: 1,
    arrive: 17,
    depart: 5.5,
    socPercent: 15,
    targetPercent: 100,
    driver: 4,
  },
  {
    name: "Cargo van 2",
    plate: "DEMO-C2",
    kind: "van",
    batteryKwh: 89,
    maxKw: 11,
    charger: 2,
    outlet: 2,
    arrive: 21,
    depart: 6,
    socPercent: 15,
    targetPercent: 100,
    driver: 5,
  },
  {
    name: "Cargo van 3",
    plate: "DEMO-C3",
    kind: "van",
    batteryKwh: 89,
    maxKw: 11,
    charger: 3,
    outlet: 2,
    arrive: 19.5,
    depart: 6,
    socPercent: 15,
    targetPercent: 95,
    driver: 6,
    alt: 12,
  },
  {
    name: "Cargo van 4",
    plate: "DEMO-C4",
    kind: "van",
    batteryKwh: 68,
    maxKw: 11,
    charger: 3,
    outlet: 2,
    arrive: 20.5,
    depart: 5.75,
    socPercent: 15,
    targetPercent: 100,
    driver: 7,
  },
  {
    name: "Cargo van 5",
    plate: "DEMO-C5",
    kind: "van",
    batteryKwh: 68,
    maxKw: 11,
    charger: 4,
    outlet: 1,
    arrive: 21,
    depart: 6,
    socPercent: 15,
    targetPercent: 100,
    driver: 8,
    alt: 13,
  },
  {
    name: "City van 1",
    plate: "DEMO-S1",
    kind: "van",
    batteryKwh: 52,
    maxKw: 11,
    charger: 4,
    outlet: 2,
    arrive: 19.5,
    depart: 6.25,
    socPercent: 50,
    targetPercent: 85,
    driver: 9,
  },
  {
    name: "City van 2",
    plate: "DEMO-S2",
    kind: "van",
    batteryKwh: 52,
    maxKw: 11,
    charger: 5,
    outlet: 1,
    arrive: 17,
    depart: 6,
    socPercent: 48,
    targetPercent: 85,
    driver: 10,
    alt: 12,
  },
  {
    name: "Cargo van 6",
    plate: "DEMO-C6",
    kind: "van",
    batteryKwh: 89,
    maxKw: 19.2,
    charger: 1,
    outlet: 2,
    arrive: 21.5,
    depart: 6.5,
    socPercent: 6,
    targetPercent: 100,
    driver: 11,
  },
];

/** The scripted at-risk vehicle (Cargo van 6): arrives last, needs the most, leaves early. */
export const AT_RISK_VEHICLE = "v11";

/**
 * Scripted data change on the demo clock: the dispatcher moves a departure.
 * The earliest-departure-first split then serves the late van before it.
 */
const EVENTS = [
  { atHour: 23, vehicle: "v1", departHour: 7.25, text: "route change" },
];

/** Where the night ends: the demo clock stops here. */
const NIGHT_END_H = 24 + 8.5;
const MIN = 60_000;

export interface Sample {
  /** Epoch ms, actual allocated kW, and the "without load management" comparison. */
  t: number;
  kw: number;
  ghostKw: number;
}
export interface Outcome {
  ready: boolean;
  shortfallKwh: number;
}
export interface DemoState {
  /** UTC midnight of the demo day, epoch ms. */
  base: number;
  samples: Sample[];
  outcomes: Record<string, Outcome>;
  applied: string[];
  /** Vehicle id to the time it plugs in (epoch ms). */
  arrivals: Record<string, number>;
}

const states = new WeakMap<Depot, DemoState>();
export const demoState = (d: Depot) => states.get(d);

/**
 * Depot time: every demo time is UTC, on the server and in the browser, so the
 * night reads the same whatever zone either side runs in.
 */
export const DEMO_TZ = "UTC";
const DAY = 86400_000;
/** UTC midnight of the day containing `ms`; the simulated night starts at 16:30 that day. */
export const dayStart = (ms: number) => Math.floor(ms / DAY) * DAY;
const atHour = (base: number, h: number) => base + Math.round(h * 3600_000);

export const indexOf = (vehicleId: string) => Number(vehicleId.slice(1));

/** Where a vehicle is planned to charge, for labels. */
export function planOf(vehicleId: string) {
  const p = PLANS[indexOf(vehicleId)];
  const c = p && CHARGERS.find((x) => x.id === p.charger);
  if (!p || !c) return undefined;
  return {
    charger: c.name,
    outlet: p.outlet,
    outlets: c.outlets,
    type: c.type,
    ratedKw: Math.min(c.kw, p.maxKw),
  };
}

/** Small deterministic generator, so seeded history is the same on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed the depot for the night of `base` (a UTC midnight). The same base gives the same night. */
export async function seedDemo(depot: Depot, base = dayStart(Date.now())) {
  await depot.store.clear();
  depot.settings.siteCapKw = DEMO_CAP_KW;
  depot.settings.currency = DEMO_CURRENCY;
  depot.settings.centsPerKwh = DEMO_CENTS_PER_KWH;
  depot.clock = new Date(atHour(base, 16.5));
  const state: DemoState = {
    base,
    samples: [],
    outcomes: {},
    applied: [],
    arrivals: {},
  };
  states.set(depot, state);
  const drivers: Driver[] = DRIVERS.map((name, i) => ({
    id: `d${i}`,
    name,
    idTag: `FLT-${(0x4a10 + i * 0x2f3).toString(16).toUpperCase()}-${7000 + i * 13}`,
    cardBlocked: false,
  }));
  for (const d of drivers) await depot.store.put("drivers", d.id, d);
  for (const [i, p] of PLANS.entries()) {
    const v: Vehicle = {
      id: `v${i}`,
      name: p.name,
      plate: p.plate,
      kind: p.kind,
      batteryKwh: p.batteryKwh,
      maxKw: p.maxKw,
      driverId: `d${p.driver}`,
      departure: new Date(atHour(base, 24 + p.depart)).toISOString(),
      need: { kind: "battery", targetPercent: p.targetPercent },
      socPercent: p.socPercent,
    };
    await depot.store.put("vehicles", v.id, v);
    state.arrivals[v.id] = atHour(base, p.arrive);
  }
  await seedHistory(depot, base);
  await logEvent(
    depot,
    "demo.ready",
    "Simulated depot: 12 vehicles on 8 chargers, a 150 kW site cap, vehicles leave 05:30-07:15",
  );
}

/** About six weeks of earlier sessions, so this month and last month both have reports. */
async function seedHistory(depot: Depot, base: number) {
  const rand = rng(20261023);
  for (let day = 1; day <= 45; day++) {
    const dayMs = base - day * DAY;
    const weekday = new Date(dayMs).getUTCDay();
    const used = new Set<number>();
    for (const [i, p] of PLANS.entries()) {
      // Not every vehicle runs every day; weekends are quiet.
      if (rand() > (weekday === 0 || weekday === 6 ? 0.35 : 0.88)) continue;
      const arrive = p.arrive + (rand() - 0.5) * 2;
      const startedAt = new Date(dayMs + Math.round(arrive * 3600_000));
      const share = 0.35 + rand() * 0.5;
      const kwh = Math.round(p.batteryKwh * share * 10) / 10;
      // A relief driver takes at most one vehicle a day.
      const relief = p.alt !== undefined && rand() < 0.4 && !used.has(p.alt);
      if (relief) used.add(p.alt!);
      const driver = relief ? p.alt! : p.driver;
      const id = `seed-${day}-${i}`;
      await depot.store.put("transactions", id, {
        id,
        vehicleId: `v${i}`,
        driverId: `d${driver}`,
        startedAt: startedAt.toISOString(),
        meterStartWh: 1_000_000,
        meterStopWh: 1_000_000 + Math.round(kwh * 1000),
      });
    }
  }
}

/** Start the night again: the same depot, the clock back at 16:30. */
export async function resetDemo(depot: Depot) {
  await seedDemo(depot, states.get(depot)?.base);
}

/** The simulated clock moves in whole steps of this size, from 00:00 depot time. */
export const STEP_MS = 5 * MIN;
/** The step at or before `ms`. Every step starts on this grid, so a replay is identical. */
export const snap = (ms: number) => Math.floor(ms / STEP_MS) * STEP_MS;

export const nightStartOf = (base: number) => atHour(base, 16.5);
export const nightEndOf = (base: number) => atHour(base, NIGHT_END_H);
const nightEnd = (s: DemoState) => nightEndOf(s.base);

/** Energy a vehicle still needs, kWh, given what its session delivered. */
function remainingKwh(v: Vehicle, deliveredKwh: number) {
  if (v.need?.kind === "kwh") return Math.max(0, v.need.kwh - deliveredKwh);
  return energyNeededKwh({
    kind: "battery",
    batteryKwh: v.batteryKwh,
    currentPercent: (v.socPercent ?? 0) + (deliveredKwh / v.batteryKwh) * 100,
    targetPercent: v.need?.targetPercent ?? 100,
  });
}

/** Advance the simulated clock by whole steps: arrivals, energy delivery, departures, scripted changes. */
export async function advanceDemo(depot: Depot, minutes: number) {
  if (!depot.clock) return;
  await advanceDemoTo(depot, depot.clock.getTime() + minutes * MIN);
}

/**
 * Move the simulated clock to the last step at or before `target`. The night is a
 * pure function of the step it is at, so any instance replaying from 16:30 lands
 * on the same board.
 */
export async function advanceDemoTo(depot: Depot, target: number) {
  const st = states.get(depot);
  if (!depot.demo || !depot.clock || !st) return;
  const end = snap(Math.min(target, nightEnd(st)));
  while (depot.clock.getTime() < end - 1) {
    const from = depot.clock.getTime();
    const vehicles = await depot.store.list("vehicles");
    // Stop at the next arrival, departure or scripted change so each happens on time.
    const marks = [
      ...Object.values(st.arrivals),
      ...vehicles.map((v) => (v.departure ? Date.parse(v.departure) : 0)),
      ...EVENTS.map((e) => atHour(st.base, e.atHour)),
    ].filter((m) => m > from);
    const t = Math.min(end, from + 5 * MIN, ...marks);
    const dtH = (t - from) / 3600_000;
    depot.clock = new Date(t);
    for (const s of await depot.store.list("sessions")) {
      s.meterWh += Math.round(s.allocatedKw * dtH * 1000);
      await depot.store.put("sessions", s.id, s);
    }
    for (const e of EVENTS) {
      if (t < atHour(st.base, e.atHour) || st.applied.includes(e.vehicle))
        continue;
      st.applied.push(e.vehicle);
      const v = vehicles.find((x) => x.id === e.vehicle);
      if (!v) continue;
      v.departure = new Date(atHour(st.base, 24 + e.departHour)).toISOString();
      await depot.store.put("vehicles", v.id, v);
      await logEvent(
        depot,
        "departure.changed",
        `${v.name}: departure moved to ${new Date(v.departure).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: DEMO_TZ })} (${e.text})`,
      );
    }
    for (const v of await depot.store.list("vehicles")) {
      const plan = PLANS[indexOf(v.id)];
      const charger = CHARGERS.find((c) => c.id === plan.charger)!;
      const depart = Date.parse(v.departure!);
      const active = (await depot.store.list("sessions")).find(
        (s) => s.vehicleId === v.id,
      );
      if (!active && t >= st.arrivals[v.id] && t < depart) {
        const had = (await depot.store.list("transactions")).some(
          (x) =>
            x.vehicleId === v.id &&
            Date.parse(x.startedAt) >= st.arrivals[v.id],
        );
        if (!had)
          await startSession(depot, {
            vehicleId: v.id,
            stationId: charger.id,
            stationName: `DEMO-${charger.name}`,
            connectorId: charger.id * 100 + plan.outlet,
            connectorNumber: plan.outlet,
            connectorKw: charger.kw,
            meterStartWh: 2_000_000,
          });
      } else if (active && t >= depart) {
        const left = remainingKwh(
          v,
          whToKwh(active.meterWh - active.meterStartWh),
        );
        st.outcomes[v.id] = { ready: left <= 0.1, shortfallKwh: left };
        await endSession(depot, active.id);
      }
    }
    await replan(depot);
    await sample(depot, st, t);
  }
}

/** Record actual power and the comparison line at time t. */
async function sample(depot: Depot, st: DemoState, t: number) {
  const sessions = await depot.store.list("sessions");
  const kw = sessions.reduce((a, s) => a + s.allocatedKw, 0);
  let ghostKw = 0;
  for (const v of await depot.store.list("vehicles")) {
    const plugged = t >= st.arrivals[v.id] && t < Date.parse(v.departure ?? "");
    if (plugged) ghostKw += planOf(v.id)?.ratedKw ?? 0;
  }
  st.samples.push({ t, kw, ghostKw });
}

export function peaks(st: DemoState) {
  return {
    peakKw: Math.max(0, ...st.samples.map((s) => s.kw)),
    ghostPeakKw: Math.max(0, ...st.samples.map((s) => s.ghostKw)),
  };
}

export const nightWindow = (st: DemoState) => ({
  start: atHour(st.base, 16.5),
  end: nightEnd(st),
});
