import "server-only";
import { randomUUID } from "node:crypto";
import { config, isDemo } from "./config";
import { describeError, ivora, IvoraError, type Operation } from "./ivora";
import { splitPower } from "./power";
import { buildReport, type TxRecord } from "./reports";
import { computeSchedule, toProfileInput } from "./schedule";
import { createStore, type Store } from "./store";
import type { Session, Settings, Vehicle } from "./types";
import { clampPercent, whToKwh, type EnergyNeed } from "./units";
import { seedDemo } from "./demo";

export interface Depot {
  demo: boolean;
  store: Store;
  settings: Settings;
  /** Simulated clock in demo mode. */
  clock: Date | null;
}

const g = globalThis as unknown as {
  __depot?: Promise<Depot>;
  __depotLock?: Promise<unknown>;
};

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

/**
 * Run state changes one at a time in this process, so a webhook and an operator
 * action cannot replan concurrently. Run one app instance per depot.
 */
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = (g.__depotLock ?? Promise.resolve()).then(fn, fn);
  g.__depotLock = run.catch(() => undefined);
  return run;
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

/** Energy still needed by departure, after what this session delivered. */
function needOf(v: Vehicle, s?: Session): EnergyNeed {
  const delivered = s ? whToKwh(s.meterWh - s.meterStartWh) : 0;
  if (v.need?.kind === "kwh")
    return { kind: "kwh", kwh: v.need.kwh - delivered };
  // A state of charge reported by the charger wins over our estimate.
  const current =
    s?.reportedSocPercent ??
    (v.socPercent ?? 0) + (delivered / v.batteryKwh) * 100;
  return {
    kind: "battery",
    batteryKwh: v.batteryKwh,
    currentPercent: current,
    targetPercent: v.need?.targetPercent ?? 100,
  };
}

/** The connector's limit for this session, kW. */
function connectorLimitKw(s: Session, v?: Vehicle): number {
  const conn = s.connectorKw ?? (v ? Infinity : config.defaultConnectorKw);
  return Math.min(v?.maxKw ?? Infinity, conn);
}

function wantedKw(s: Session, v: Vehicle | undefined, at: Date): number {
  // A session we could not match to a vehicle still draws power: reserve its connector limit.
  if (!v) return connectorLimitKw(s);
  if (!v.departure) return 0;
  return computeSchedule({
    need: needOf(v, s),
    now: at,
    departure: new Date(v.departure),
    maxKw: connectorLimitKw(s, v),
  }).chargeKw;
}

/**
 * Recompute allocations for all active sessions and apply a charging profile for each
 * whose allocation changed. Called when a vehicle plugs in or leaves, and on edits.
 */
export async function replan(d: Depot): Promise<void> {
  const at = now(d);
  const sessions = await d.store.list("sessions");
  const vehicles = new Map(
    (await d.store.list("vehicles")).map((v) => [v.id, v]),
  );
  const split = splitPower(
    d.settings.siteCapKw,
    sessions.map((s) => {
      const v = s.vehicleId ? vehicles.get(s.vehicleId) : undefined;
      return {
        id: s.id,
        departureMs: v?.departure ? Date.parse(v.departure) : Infinity,
        wantedKw: wantedKw(s, v, at),
      };
    }),
  );
  for (const s of sessions) {
    const v = s.vehicleId ? vehicles.get(s.vehicleId) : undefined;
    s.allocatedKw = split.get(s.id) ?? 0;
    await d.store.put("sessions", s.id, s);
    if (v || !d.demo) await applyProfile(d, s, v, at);
  }
}

const changed = (a: number, b: number) => Math.abs(a - b) >= 0.1;

/** Send the session's plan as a charging profile, unless the station already has it. */
async function applyProfile(
  d: Depot,
  s: Session,
  v: Vehicle | undefined,
  at: Date,
) {
  const p = s.profile;
  const retry = p && p.status === "error" && p.retriable && p.body;
  if (p && !retry && !changed(p.kw, s.allocatedKw)) return;
  const name = v?.name ?? `card ${s.idTokenHint ?? "unknown"}`;

  if (d.demo) {
    // Demo never sends charger commands: the station's answer is simulated.
    s.profile = {
      status: "accepted",
      seq: (p?.seq ?? 0) + 1,
      key: "demo",
      kw: s.allocatedKw,
      at: at.toISOString(),
      composite: `${Math.round(s.allocatedKw * 1000)} W now, simulated`,
    };
    await d.store.put("sessions", s.id, s);
    await logEvent(
      d,
      "charging_profile.accepted",
      `${name}: ${s.allocatedKw.toFixed(1)} kW (simulated)`,
    );
    return;
  }
  if (!s.transactionId) return;

  // A retry of a failed send reuses the same key and the same body.
  let next = s.profile;
  if (!retry || !next) {
    const seq = (p?.seq ?? 0) + 1;
    const sched = computeSchedule({
      need: v ? needOf(v, s) : { kind: "kwh", kwh: Infinity },
      now: at,
      departure: v?.departure
        ? new Date(v.departure)
        : new Date(at.getTime() + 12 * 3600_000),
      maxKw: connectorLimitKw(s, v),
      allowedKw: s.allocatedKw,
    });
    next = {
      status: "sending",
      seq,
      key: `fd-profile-${s.id}-${seq}`,
      body: toProfileInput(sched, {
        transactionId: s.transactionId,
        startAt: at,
      }),
      kw: s.allocatedKw,
      at: at.toISOString(),
      profileId: p?.profileId,
    };
  }
  s.profile = next;
  await d.store.put("sessions", s.id, s);

  const api = ivora();
  try {
    // OCPP 2.x refuses a second profile at the same purpose, EVSE and stack level:
    // clear the previous one first. OCPP 1.6 replaces it in place.
    if (p?.profileId && !s.protocol?.startsWith("ocpp1.6")) {
      await api
        .clearChargingProfile(
          s.stationId,
          p.profileId,
          `fd-clear-${p.profileId}`,
        )
        .catch((e) => {
          if (!(
            e instanceof IvoraError && e.code === "charging_profile_inactive"
          ))
            throw e;
        });
    }
    const op = await api.setChargingProfile(
      s.stationId,
      next.body as Parameters<typeof api.setChargingProfile>[1],
      next.key,
    );
    const r = (op.result ?? {}) as {
      profile_id?: string;
      charger_status?: string | null;
      error?: { code?: string; message?: string };
    };
    next.profileId = r.profile_id ?? next.profileId;
    if (op.status === "rejected") {
      next.status = "rejected";
      next.detail = `${r.error?.code ?? "rejected"}: ${r.error?.message ?? ""}`;
    } else if (r.charger_status === "Accepted") next.status = "accepted";
    else if (r.charger_status) {
      next.status = "rejected";
      next.detail = `charger answered ${r.charger_status}`;
    } else next.status = "pending"; // the charging_profile.* webhook brings the answer
    next.retriable = false;
    if (next.status !== "rejected") {
      next.composite = await readComposite(
        d,
        s,
        next.seq,
        Math.min(
          next.body
            ? (next.body as { duration_seconds: number }).duration_seconds
            : 3600,
          86400,
        ),
      );
    }
    await logEvent(
      d,
      `charging_profile.${next.status === "pending" ? "sent" : next.status}`,
      `${name}: ${s.allocatedKw.toFixed(1)} kW${next.detail ? ` (${next.detail})` : ""}`,
    );
  } catch (e) {
    next.status = "error";
    next.retriable = e instanceof IvoraError && e.retriable;
    next.detail = describeError(e);
    await logEvent(d, "charging_profile.error", `${name}: ${next.detail}`);
  }
  s.profile = next;
  await d.store.put("sessions", s.id, s);
}

/** Ask the station what it will actually apply, and describe the first period. */
async function readComposite(
  d: Depot,
  s: Session,
  seq: number,
  durationSeconds: number,
): Promise<string> {
  const api = ivora();
  try {
    let op: Operation = await api.compositeSchedule(
      s.stationId,
      {
        duration_seconds: durationSeconds,
        connector_id: s.connectorId,
        unit: "W",
      },
      `fd-composite-${s.id}-${seq}`,
    );
    for (let n = 0; n < 3 && op.status === "dispatching"; n++) {
      await api.sleep(1000);
      op = await api.getOperation(op.id);
    }
    if (op.status === "dispatching") return "composite requested";
    const schedule = (
      op.result as {
        schedule?: { periods?: { limit: number }[]; unit?: string } | null;
      } | null
    )?.schedule;
    if (op.status !== "succeeded" || !schedule)
      return "station gave no composite schedule";
    const first = schedule.periods?.[0];
    return first ? `${first.limit} ${schedule.unit ?? "W"} now` : "no limit";
  } catch (e) {
    return `composite failed: ${describeError(e)}`;
  }
}

export interface SessionStart {
  vehicleId?: string;
  idTokenHint?: string;
  stationId: number;
  stationName?: string;
  protocol?: string;
  connectorId: number;
  connectorNumber?: number;
  connectorKw?: number;
  transactionId?: number;
  meterStartWh: number;
  startedAt?: string;
}

export async function startSession(d: Depot, x: SessionStart) {
  const s: Session = {
    id: x.transactionId ? `tx-${x.transactionId}` : randomUUID(),
    vehicleId: x.vehicleId,
    idTokenHint: x.idTokenHint,
    stationId: x.stationId,
    stationName: x.stationName,
    protocol: x.protocol,
    connectorId: x.connectorId,
    connectorNumber: x.connectorNumber,
    connectorKw: x.connectorKw,
    transactionId: x.transactionId,
    startedAt: x.startedAt ?? now(d).toISOString(),
    meterStartWh: x.meterStartWh,
    meterWh: x.meterStartWh,
    allocatedKw: 0,
  };
  await d.store.put("sessions", s.id, s);
  const v = x.vehicleId
    ? (await d.store.list("vehicles")).find((y) => y.id === x.vehicleId)
    : undefined;
  await logEvent(
    d,
    "session.started",
    `${v?.name ?? `Unknown vehicle (card ${x.idTokenHint ?? "?"})`} on ${x.stationName ?? x.stationId} / ${x.connectorNumber ?? x.connectorId}`,
  );
  await replan(d);
  return s;
}

/** End a session. `energyWh` is the transaction total when the API reports it. */
export async function endSession(
  d: Depot,
  sessionId: string,
  energyWh?: number,
) {
  const s = (await d.store.list("sessions")).find((x) => x.id === sessionId);
  if (!s) return;
  const v = s.vehicleId
    ? (await d.store.list("vehicles")).find((x) => x.id === s.vehicleId)
    : undefined;
  await d.store.remove("sessions", s.id);
  const stopWh = energyWh !== undefined ? s.meterStartWh + energyWh : s.meterWh;
  await d.store.put("transactions", s.id, {
    id: s.id,
    vehicleId: v?.id ?? "unknown",
    driverId: v?.driverId ?? "unknown",
    startedAt: s.startedAt,
    meterStartWh: s.meterStartWh,
    meterStopWh: stopWh,
  });
  if (v?.need?.kind === "battery") {
    // Remember where the battery ended for the next plug-in.
    v.socPercent = clampPercent(
      s.reportedSocPercent ??
        (v.socPercent ?? 0) +
          (whToKwh(stopWh - s.meterStartWh) / v.batteryKwh) * 100,
    );
    await d.store.put("vehicles", v.id, v);
  }
  await logEvent(
    d,
    "session.ended",
    `${v?.name ?? `card ${s.idTokenHint ?? "?"}`}: ${whToKwh(stopWh - s.meterStartWh).toFixed(1)} kWh`,
  );
  await replan(d);
}

/** Show only the last 4 characters of a card value: a copied value can start charging. */
export const maskTag = (tag?: string) =>
  tag ? `****${tag.slice(-4)}` : undefined;

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
    const socReported = s?.reportedSocPercent !== undefined;
    const soc =
      s?.reportedSocPercent ??
      (v.socPercent === undefined
        ? undefined
        : clampPercent(
            v.socPercent + (s ? (delivered / v.batteryKwh) * 100 : 0),
          ));
    const need = s ? needOf(v, s) : undefined;
    const remainingKwh =
      need === undefined
        ? undefined
        : need.kind === "kwh"
          ? Math.max(0, need.kwh)
          : Math.max(
              0,
              (need.batteryKwh *
                (clampPercent(need.targetPercent) -
                  clampPercent(need.currentPercent))) /
                100,
            );
    // On track when what is left fits in the time left at the allocated power.
    const readyBy =
      v.departure && s && remainingKwh !== undefined
        ? remainingKwh <= 0.05 ||
          (s.allocatedKw *
            Math.max(0, Date.parse(v.departure) - at.getTime())) /
            3600_000 >=
            remainingKwh - 0.05
        : undefined;
    return {
      vehicle: v,
      driver: drivers.find((x) => x.id === v.driverId)?.name,
      session: s && publicSession(s),
      soc,
      socReported,
      remainingKwh,
      readyBy,
    };
  });
  return {
    demo: d.demo,
    now: at.toISOString(),
    settings: d.settings,
    totalKw: sessions.reduce((a, s) => a + s.allocatedKw, 0),
    rows,
    unmatched: sessions.filter((s) => !s.vehicleId).map(publicSession),
    drivers: drivers.map((x) => ({
      id: x.id,
      name: x.name,
      card: maskTag(x.idTag),
      cardBlocked: x.cardBlocked,
      cardError: x.cardError,
    })),
    events: events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30),
  };
}

/** What the browser may see of a session (no idempotency keys or request bodies). */
function publicSession(s: Session) {
  return {
    id: s.id,
    station: s.stationName ?? String(s.stationId),
    connector: s.connectorNumber ?? s.connectorId,
    allocatedKw: s.allocatedKw,
    deliveredKwh: whToKwh(s.meterWh - s.meterStartWh),
    idTokenHint: s.idTokenHint,
    profile: s.profile && {
      status: s.profile.status,
      detail: s.profile.detail,
      composite: s.profile.composite,
    },
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
  const labels: Record<string, string> = { unknown: "Unmatched card" };
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
