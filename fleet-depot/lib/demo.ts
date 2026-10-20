import type { Depot } from "./depot";
import { endSession, logEvent, replan, startSession } from "./depot";
import type { Driver, Vehicle } from "./types";

const DRIVERS = [
  "Avery Stone",
  "Jordan Lee",
  "Sam Okafor",
  "Riley Park",
  "Casey Moreno",
  "Morgan Diaz",
];
const FLEET: Omit<
  Vehicle,
  "id" | "driverId" | "departure" | "need" | "socPercent"
>[] = [
  { name: "Van 1", plate: "DEMO-V1", kind: "van", batteryKwh: 75, maxKw: 11 },
  { name: "Van 2", plate: "DEMO-V2", kind: "van", batteryKwh: 75, maxKw: 11 },
  { name: "Van 3", plate: "DEMO-V3", kind: "van", batteryKwh: 60, maxKw: 11 },
  { name: "Bus 1", plate: "DEMO-B1", kind: "bus", batteryKwh: 250, maxKw: 22 },
  { name: "Car 1", plate: "DEMO-C1", kind: "car", batteryKwh: 58, maxKw: 11 },
  { name: "Car 2", plate: "DEMO-C2", kind: "car", batteryKwh: 58, maxKw: 7.4 },
];
const ARRIVE_H = [17, 17.5, 18, 18.5, 20, 21]; // hours after midnight
const DEPART_H = [6, 6.5, 7, 5.5, 7.5, 8]; // next morning
const SOC = [25, 30, 20, 35, 40, 15];

/** Local-day-based demo times; the simulated clock starts at 16:30 on the current day. */
export function dayStart(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
const atHour = (base: Date, h: number) =>
  new Date(base.getTime() + h * 3600_000);

export async function seedDemo(depot: Depot) {
  await depot.store.clear();
  const base = dayStart(new Date());
  depot.clock = atHour(base, 16.5);
  for (let i = 0; i < FLEET.length; i++) {
    const driver: Driver = {
      id: `d${i}`,
      name: DRIVERS[i],
      idTag: `DEMO${1000 + i}`,
      cardBlocked: false,
    };
    const v: Vehicle = {
      ...FLEET[i],
      id: `v${i}`,
      driverId: driver.id,
      departure: atHour(base, 24 + DEPART_H[i]).toISOString(),
      need: { kind: "battery", targetPercent: 90 },
      socPercent: SOC[i],
    };
    await depot.store.put("drivers", driver.id, driver);
    await depot.store.put("vehicles", v.id, v);
  }
  // Earlier sessions this month so the report has data (kept in the same month as the clock).
  const month = base.toISOString().slice(0, 7);
  for (let day = 0; day < 6; day++) {
    for (let i = 0; i < FLEET.length; i++) {
      const started = new Date(
        base.getTime() - (day + 1) * 86400_000 + ARRIVE_H[i] * 3600_000,
      );
      if (started.toISOString().slice(0, 7) !== month) continue;
      const kwh = FLEET[i].batteryKwh * 0.5 + day * 2;
      await depot.store.put("transactions", `seed-${day}-${i}`, {
        id: `seed-${day}-${i}`,
        vehicleId: `v${i}`,
        driverId: `d${i}`,
        startedAt: started.toISOString(),
        meterStartWh: 1_000_000,
        meterStopWh: 1_000_000 + Math.round(kwh * 1000),
      });
    }
  }
  await logEvent(
    depot,
    "demo.ready",
    "Simulated depot: vehicles arrive 17:00-21:00 and leave 05:30-08:00",
  );
}

/** Advance the simulated clock: arrivals, energy delivery, departures. */
export async function advanceDemo(depot: Depot, minutes: number) {
  if (!depot.demo || !depot.clock) return;
  const base = dayStart(depot.clock);
  const steps = Math.max(1, Math.ceil(minutes / 5));
  for (let n = 0; n < steps; n++) {
    const dtH = minutes / steps / 60;
    depot.clock = new Date(depot.clock.getTime() + dtH * 3600_000);
    const t = depot.clock;
    const vehicles = await depot.store.list("vehicles");
    let sessions = await depot.store.list("sessions");
    for (const s of sessions) {
      s.meterWh += Math.round(s.allocatedKw * dtH * 1000);
      await depot.store.put("sessions", s.id, s);
    }
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      const idx = Number(v.id.slice(1));
      const arrive = atHour(base, ARRIVE_H[idx]);
      const depart = new Date(v.departure!);
      sessions = await depot.store.list("sessions");
      const active = sessions.find((s) => s.vehicleId === v.id);
      if (
        !active &&
        t >= arrive &&
        t < depart &&
        !(await hasTxSince(depot, v.id, arrive))
      ) {
        await startSession(depot, {
          vehicleId: v.id,
          stationId: 1,
          stationName: "DEMO-ST-1",
          connectorId: 100 + idx,
          connectorNumber: idx + 1,
          meterStartWh: 2_000_000,
        });
      } else if (active && t >= depart) {
        await endSession(depot, active.id);
      }
    }
  }
  await replan(depot);
}

async function hasTxSince(depot: Depot, vehicleId: string, since: Date) {
  const txs = await depot.store.list("transactions");
  return txs.some(
    (x) =>
      x.vehicleId === vehicleId && Date.parse(x.startedAt) >= since.getTime(),
  );
}
