import { randomUUID } from "node:crypto";
import { config, isDemo } from "./config";
import { describeError, ivora } from "./ivora";
import { splitPower } from "./power";
import { buildReport, type TxRecord } from "./reports";
import { computeSchedule, toChargingProfile } from "./schedule";
import { createStore, type Store } from "./store";
import type { Driver, Session, Settings, Vehicle } from "./types";
import { whToKwh, type EnergyNeed } from "./units";
import { seedDemo } from "./demo";

export interface Depot {
  demo: boolean;
  store: Store;
  settings: Settings;
  /** Simulated clock in demo mode. */
  clock: Date | null;
}

const g = globalThis as unknown as { __depot?: Promise<Depot> };

export function getDepot(): Promise<Depot> {
  g.__depot ??= (async () => {
    const demo = isDemo();
    const depot: Depot = {
      demo,
      store: await createStore(demo),
      settings: {
        siteCapKw: config.siteCapKw,
        centsPerKwh: config.centsPerKwh,
        currency: config.currency,
      },
      clock: null,
    };
    if (demo) await seedDemo(depot);
    return depot;
  })();
  return g.__depot;
}

export const now = (d: Depot) => d.clock ?? new Date();

export async function logEvent(d: Depot, type: string, detail: string) {
  const id = randomUUID();
  await d.store.put("events", id, {
    id,
    at: now(d).toISOString(),
    type,
    detail,
  });
}

/** Wanted power per vehicle, before the site cap. */
function needOf(v: Vehicle, s?: Session): EnergyNeed {
  const delivered = s ? whToKwh(s.meterWh - s.meterStartWh) : 0;
  if (v.need?.kind === "kwh")
    return { kind: "kwh", kwh: v.need.kwh - delivered };
  return {
    kind: "battery",
    batteryKwh: v.batteryKwh,
    currentPercent: (v.socPercent ?? 0) + (delivered / v.batteryKwh) * 100,
    targetPercent: v.need?.targetPercent ?? 100,
  };
}

function wantedKw(v: Vehicle, at: Date, s?: Session): number {
  if (!v.departure) return 0;
  return computeSchedule({
    need: needOf(v, s),
    now: at,
    departure: new Date(v.departure),
    maxKw: v.maxKw,
  }).chargeKw;
}

/**
 * Recompute allocations for all active sessions and apply a charging profile for each.
 * Call when a vehicle plugs in or leaves.
 */
export async function replan(d: Depot): Promise<void> {
  const at = now(d);
  const sessions = await d.store.list("sessions");
  const vehicles = new Map(
    (await d.store.list("vehicles")).map((v) => [v.id, v]),
  );
  const split = splitPower(
    d.settings.siteCapKw,
    sessions.flatMap((s) => {
      const v = vehicles.get(s.vehicleId);
      if (!v) return [];
      return [
        {
          id: s.id,
          departureMs: v.departure ? Date.parse(v.departure) : Infinity,
          wantedKw: wantedKw(v, at, s),
        },
      ];
    }),
  );
  for (const s of sessions) {
    const v = vehicles.get(s.vehicleId);
    if (!v) continue;
    const prevKw = s.allocatedKw;
    const prevOk = s.profile?.status === "accepted";
    s.allocatedKw = split.get(s.id) ?? 0;
    const sched = computeSchedule({
      need: needOf(v, s),
      now: at,
      departure: v.departure ? new Date(v.departure) : at,
      maxKw: v.maxKw,
      allowedKw: s.allocatedKw,
    });
    const profile = toChargingProfile(sched, {
      profileId: Math.abs(hash(s.id)) % 100000,
      startSchedule: at,
      durationSeconds: sched.availableSeconds,
    });
    s.profile = { status: "pending", at: at.toISOString() };
    if (d.demo) {
      if (prevOk && Math.abs(prevKw - s.allocatedKw) < 0.05) {
        s.profile = {
          status: "accepted",
          at: at.toISOString(),
          composite: `${Math.round(s.allocatedKw * 1000)} W (simulated)`,
        };
        await d.store.put("sessions", s.id, s);
        continue;
      }
      // Demo never sends charger commands: the station's answer is simulated.
      s.profile = {
        status: "accepted",
        at: at.toISOString(),
        composite: `${Math.round(s.allocatedKw * 1000)} W (simulated)`,
      };
      await logEvent(
        d,
        "charging_profile.accepted",
        `${v.name}: ${s.allocatedKw.toFixed(1)} kW (simulated)`,
      );
    } else {
      try {
        await ivora.setChargingProfile(
          s.stationId,
          s.connectorId,
          profile,
          `profile-${s.id}-${at.getTime()}`,
        );
        const comp = await ivora.compositeSchedule(
          s.stationId,
          s.connectorId,
          sched.availableSeconds,
        );
        const first = comp.chargingSchedulePeriod?.[0]?.limit;
        s.profile.composite =
          first === undefined ? "no composite schedule" : `${first} W`;
      } catch (e) {
        s.profile = {
          status: "rejected",
          at: at.toISOString(),
          detail: describeError(e),
        };
        await logEvent(d, "profile.error", `${v.name}: ${describeError(e)}`);
      }
    }
    await d.store.put("sessions", s.id, s);
  }
}

function hash(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

export async function startSession(
  d: Depot,
  v: Vehicle,
  stationId: string,
  connectorId: number,
  meterWh: number,
) {
  const s: Session = {
    id: randomUUID(),
    vehicleId: v.id,
    stationId,
    connectorId,
    startedAt: now(d).toISOString(),
    meterStartWh: meterWh,
    meterWh,
    allocatedKw: 0,
  };
  await d.store.put("sessions", s.id, s);
  await logEvent(
    d,
    "transaction.started",
    `${v.name} on ${stationId}/${connectorId}`,
  );
  await replan(d);
  return s;
}

export async function endSession(
  d: Depot,
  sessionId: string,
  meterStopWh?: number,
) {
  const s = (await d.store.list("sessions")).find((x) => x.id === sessionId);
  if (!s) return;
  const v = (await d.store.list("vehicles")).find((x) => x.id === s.vehicleId);
  await d.store.remove("sessions", s.id);
  if (v) {
    await d.store.put("transactions", s.id, {
      id: s.id,
      vehicleId: v.id,
      driverId: v.driverId ?? "unknown",
      startedAt: s.startedAt,
      meterStartWh: s.meterStartWh,
      meterStopWh: meterStopWh ?? s.meterWh,
    });
    await logEvent(
      d,
      "transaction.ended",
      `${v.name}: ${whToKwh((meterStopWh ?? s.meterWh) - s.meterStartWh).toFixed(1)} kWh`,
    );
  }
  await replan(d);
}

export async function boardState(d: Depot) {
  const [vehicles, drivers, sessions, events] = await Promise.all([
    d.store.list("vehicles"),
    d.store.list("drivers"),
    d.store.list("sessions"),
    d.store.list("events"),
  ]);
  const at = now(d);
  const rows = vehicles.map((v) => {
    const s = sessions.find((x) => x.vehicleId === v.id);
    const delivered = s ? whToKwh(s.meterWh - s.meterStartWh) : 0;
    const soc =
      v.socPercent === undefined
        ? undefined
        : Math.min(
            100,
            v.socPercent + (s ? (delivered / v.batteryKwh) * 100 : 0),
          );
    const target =
      v.need?.kind === "battery" ? v.need.targetPercent : undefined;
    const readyBy =
      v.departure && s && target !== undefined && soc !== undefined
        ? soc >= target - 0.5 || wantedKw(v, at, s) <= s.allocatedKw + 1e-6
        : undefined;
    return {
      vehicle: v,
      driver: drivers.find((x) => x.id === v.driverId),
      session: s,
      soc,
      readyBy,
    };
  });
  return {
    demo: d.demo,
    now: at.toISOString(),
    settings: d.settings,
    totalKw: sessions.reduce((a, s) => a + s.allocatedKw, 0),
    rows,
    drivers,
    events: events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30),
  };
}

export async function report(
  d: Depot,
  month: string,
  by: "vehicle" | "driver",
) {
  const [vehicles, drivers, txs] = await Promise.all([
    d.store.list("vehicles"),
    d.store.list("drivers"),
    d.store.list("transactions"),
  ]);
  const labels: Record<string, string> = {};
  for (const v of vehicles) labels[v.id] = `${v.name} (${v.plate})`;
  for (const x of drivers) labels[x.id] = x.name;
  return buildReport(
    txs as TxRecord[],
    month,
    d.settings.centsPerKwh,
    by,
    labels,
  );
}

export type { Driver };
