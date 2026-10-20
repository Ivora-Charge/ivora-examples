import "server-only";
import { randomUUID } from "node:crypto";
import { config, isDemo } from "./config";
import {
  describeError,
  ivora,
  IvoraError,
  type Operation,
  type ProfileInput,
} from "./ivora";
import { splitPower } from "./power";
import { buildReport, type TxRecord } from "./reports";
import { computeSchedule, toBaselineInput, toProfileInput } from "./schedule";
import { createStore, type Store } from "./store";
import type {
  Charger,
  ProfileState,
  SentProfile,
  Session,
  Settings,
  Vehicle,
} from "./types";
import { clampPercent, wholeW, whToKwh, type EnergyNeed } from "./units";
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
        // Live mode only: demo never sends charger commands.
        baselineProfile: !demo && config.baselineProfile,
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

/** A raise smaller than this is not worth a new profile (a lower limit is always sent). */
const STEP_W = 100;

function wantedKw(s: Session, v: Vehicle | undefined, at: Date): number {
  // A session we could not match to a vehicle still draws power: reserve its connector limit.
  if (!v) return connectorLimitKw(s);
  if (!v.departure) return 0;
  const needW = wholeW(
    computeSchedule({
      need: needOf(v, s),
      now: at,
      departure: new Date(v.departure),
      maxKw: connectorLimitKw(s, v),
    }).chargeKw,
  );
  // Keep the limit in force when it is only slightly above the need, so the
  // rounding of a recomputed schedule does not send a new profile every replan.
  const cur = enforcedW(s.sent);
  return cur >= needW && cur - needW < STEP_W ? cur / 1000 : needW / 1000;
}

/**
 * The most this session may draw under the profiles sent for it, W. Infinity when
 * the charger has accepted none (it runs at its own default). Among accepted
 * profiles the highest stack level wins (OCPP 1.6 replaces at the same level);
 * one the charger has not answered yet may also be in force, so it counts too.
 */
export function enforcedW(sent: SentProfile[] = []): number {
  const confirmed = sent.filter((p) => p.confirmed);
  if (confirmed.length === 0) return Infinity;
  const top = confirmed.reduce((a, b) => (b.stack >= a.stack ? b : a));
  return Math.max(top.w, ...sent.filter((p) => !p.confirmed).map((p) => p.w));
}

/**
 * Recompute allocations for all active sessions and apply a charging profile for each
 * whose allocation changed. Called when a vehicle plugs in or leaves, on edits, on
 * webhook answers and on a timer.
 *
 * Lower limits go first. Limits are raised only once every lowered limit is in
 * force at its station; if any decrease fails or is not confirmed yet, the raises
 * wait for the next replan, so a partial update never takes the site over the cap.
 */
export async function replan(d: Depot): Promise<void> {
  const at = now(d);
  const sessions = await d.store.list("sessions");
  const vehicles = new Map(
    (await d.store.list("vehicles")).map((v) => [v.id, v]),
  );
  const vehicleOf = (s: Session) =>
    s.vehicleId ? vehicles.get(s.vehicleId) : undefined;
  const capW = wholeW(d.settings.siteCapKw);
  const chargers =
    !d.demo && d.settings.baselineProfile ? await d.store.list("chargers") : [];
  const base = baselinePlan(capW, chargers, sessions);
  const split = splitPower(
    // Idle connectors keep their baseline in reserve, so a plug-in cannot top the cap.
    Math.max(0, capW - base.idleW) / 1000,
    sessions.map((s) => {
      const v = vehicleOf(s);
      return {
        id: s.id,
        departureMs: v?.departure ? Date.parse(v.departure) : Infinity,
        wantedKw: wantedKw(s, v, at),
      };
    }),
  );
  for (const s of sessions) {
    s.allocatedKw = split.get(s.id) ?? 0;
    await d.store.put("sessions", s.id, s);
  }
  if (d.demo) {
    for (const s of sessions) {
      const v = vehicleOf(s);
      if (v) await simulateProfile(d, s, v, at);
    }
    return;
  }
  // Without a transaction there is nothing to send a session profile for.
  const live = sessions.filter((s) => s.transactionId);
  const target = (s: Session) => wholeW(s.allocatedKw);
  const over = (s: Session) => enforcedW(s.sent) > target(s);
  // What the other sessions may draw right now: a profile is never sent above
  // the cap minus that, so a session that just plugged in only gets what is free
  // while a decrease elsewhere is still on its way.
  const floorOf = (o: Session) => base.heldW(o.stationId);
  const reserved = (o: Session) => reservedW(o, target(o), floorOf(o));
  const headroom = (s: Session) =>
    capW -
    base.idleW -
    sessions.filter((o) => o !== s).reduce((sum, o) => sum + reserved(o), 0);
  const apply = (s: Session) =>
    applyProfile(
      d,
      s,
      vehicleOf(s),
      at,
      Math.max(0, Math.min(target(s), headroom(s))),
    );
  // A charger's baseline follows the same rule: lower first, raise once every lower
  // limit is in force. Its first send counts as lowering (nothing is in force yet).
  const baseOver = (c: Charger) => enforcedW(c.sent) > base.unitW;
  const applyBase = (c: Charger) =>
    applyBaseline(d, c, Math.max(0, Math.min(base.unitW, baseHeadroom(c))));
  const baseHeadroom = (c: Charger) => {
    const here = sessions.filter((o) => o.stationId === c.stationId);
    const inForce = here.filter((o) => Number.isFinite(enforcedW(o.sent)));
    const other = sessions.filter((o) => o.stationId !== c.stationId);
    const committed =
      other.reduce((sum, o) => sum + reserved(o), 0) +
      inForce.reduce((sum, o) => sum + reservedW(o, target(o)), 0) +
      here
        .filter((o) => !inForce.includes(o))
        .reduce((sum, o) => sum + (o.sent?.length ? maxSentW(o) : 0), 0) +
      base.idleW -
      base.idleOf(c);
    const n = base.unitsOf(c) - inForce.length;
    return n > 0 ? Math.floor((capW - committed) / n) : Infinity;
  };
  const lower = live.filter(over);
  const lowerBase = chargers.filter(baseOver);
  for (const s of lower) await apply(s);
  for (const c of lowerBase) await applyBase(c);
  const waiting = lower.filter(over);
  const waitingBase = lowerBase.filter(baseOver);
  if (waiting.length > 0 || waitingBase.length > 0) {
    const raises =
      live.filter((s) => !lower.includes(s) && needsSend(s, target(s))).length +
      chargers.filter((c) => !lowerBase.includes(c) && needsSend(c, base.unitW))
        .length;
    if (raises > 0)
      await logEvent(
        d,
        "plan.deferred",
        `${raises} higher limit(s) wait until the lower limit for ${[
          ...waiting.map((s) => describe(s, vehicleOf(s))),
          ...waitingBase.map((c) => `the baseline of station ${c.stationId}`),
        ].join(", ")} is in force; retried on the next replan`,
      );
    return;
  }
  for (const s of live) if (!lower.includes(s)) await apply(s);
  for (const c of chargers) if (!lowerBase.includes(c)) await applyBase(c);
}

/**
 * The baseline arithmetic of one replan (empty when the baseline is off). Every
 * connector of every known charger gets an equal share of the cap, rounded down to
 * whole watts. `idleW` is what the connectors without a session may draw, so the
 * sessions are planned within the cap minus that: a vehicle plugging in then
 * draws its baseline at most, and the site stays under the cap in the gap.
 */
function baselinePlan(capW: number, chargers: Charger[], sessions: Session[]) {
  const at = (c: Charger) =>
    sessions.filter((s) => s.stationId === c.stationId).length;
  const unitsOf = (c: Charger) => Math.max(c.units, at(c));
  const total = chargers.reduce((n, c) => n + unitsOf(c), 0);
  const unitW = total > 0 ? Math.floor(capW / total) : capW;
  /** What one connector of this charger may draw under its baseline, W. */
  const held = (c: Charger) => reservedW(c, unitW);
  const idleOf = (c: Charger) => (unitsOf(c) - at(c)) * held(c);
  return {
    unitW,
    unitsOf,
    idleOf,
    idleW: chargers.reduce((sum, c) => sum + idleOf(c), 0),
    /** The baseline in force (or sent) where a session starts, W; 0 when there is none. */
    heldW: (stationId: number) => {
      const c = chargers.find((x) => x.stationId === stationId);
      return c ? held(c) : 0;
    },
  };
}

const maxSentW = (s: { sent?: SentProfile[] }) =>
  Math.max(0, ...(s.sent ?? []).map((p) => p.w));

/**
 * What a session may draw as far as the app knows, W. A session without an
 * accepted profile counts at the most it was sent, or else at its allocation
 * (and at least the charger's baseline, when that is on).
 */
function reservedW(
  s: { sent?: SentProfile[] },
  targetW: number,
  baselineW = 0,
): number {
  const b = enforcedW(s.sent);
  if (Number.isFinite(b)) return b;
  // Until its first profile is in force a session is limited by the charger's baseline.
  return Math.max(baselineW, s.sent?.length ? maxSentW(s) : targetW);
}

const describe = (s: Session, v?: Vehicle) =>
  v?.name ?? `card ${s.idTokenHint ?? "unknown"}`;

/** True when the latest profile does not match the goal (or there is none). */
function needsSend(s: { sent?: SentProfile[] }, goalW: number): boolean {
  const latest = s.sent?.at(-1);
  if (!latest) return true;
  return latest.w > goalW || goalW - latest.w >= STEP_W;
}

/** Demo never sends charger commands: the station's answer is simulated. */
async function simulateProfile(d: Depot, s: Session, v: Vehicle, at: Date) {
  const w = wholeW(s.allocatedKw);
  if (!needsSend(s, w)) return;
  const seq = (s.profile?.seq ?? 0) + 1;
  s.sent = [{ key: "demo", body: null, w, stack: 1, confirmed: true }];
  s.profile = {
    status: "accepted",
    seq,
    key: "demo",
    kw: s.allocatedKw,
    at: at.toISOString(),
    composite: `${w} W now, simulated`,
  };
  await d.store.put("sessions", s.id, s);
  await logEvent(
    d,
    "charging_profile.accepted",
    `${v.name}: ${s.allocatedKw.toFixed(1)} kW (simulated)`,
  );
}

/** What the profile helpers need: a session or a charger's baseline. */
interface Holder {
  stationId: number;
  protocol?: string;
  sent?: SentProfile[];
  profile?: ProfileState;
}

const isV16 = (s: Holder) => s.protocol?.startsWith("ocpp1.6") ?? false;

/**
 * Bring the session's profiles in line with `targetW`: its allocation, or less
 * while the rest of the site has not made room yet (live mode). Never throws: a
 * failure is recorded on the session and in the event log, and the profile stays
 * counted at its old limit until the station confirms otherwise.
 */
async function applyProfile(
  d: Depot,
  s: Session,
  v: Vehicle | undefined,
  at: Date,
  targetW: number,
) {
  const sent = (s.sent ??= []);
  const name = describe(s, v);
  const save = () => d.store.put("sessions", s.id, s);
  try {
    // 1. Settle what is in flight: resend a request whose outcome is unknown (same
    // key, same body), and read the state of profiles the charger has not answered.
    for (const p of [...sent]) {
      if (!p.profileId) await postProfile(s, p);
      else if (!p.confirmed) await refreshProfile(s, p);
    }
    await save();

    // 2. Nothing to send when the latest profile matches; tidy up older ones.
    if (!needsSend(s, targetW)) {
      const latest = sent.at(-1)!;
      if (latest.confirmed) await retireOlder(s, latest);
      await save();
      return;
    }

    // 3. Send a new profile. OCPP 1.6 replaces the one at the same stack level.
    // OCPP 2.x refuses a second profile at the same level, so alternate between
    // levels 1 and 2 and clear the older one once the new one is accepted: the
    // limit in force is always the old or the new one, never none.
    let stack = 1;
    if (!isV16(s)) {
      const top = topConfirmed(sent);
      for (const p of sent.filter((x) => x !== top)) await clearProfile(s, p);
      if (sent.some((x) => x !== top)) {
        const why = "waiting for the station to clear an earlier profile";
        show(s, "error", why);
        await save();
        await logEvent(d, "charging_profile.error", `${name}: ${why}`);
        return;
      }
      stack = top?.stack === 1 ? 2 : 1;
    }
    const seq = (s.profile?.seq ?? 0) + 1;
    const sched = computeSchedule({
      need: v ? needOf(v, s) : { kind: "kwh", kwh: Infinity },
      now: at,
      departure: v?.departure
        ? new Date(v.departure)
        : new Date(at.getTime() + 12 * 3600_000),
      maxKw: connectorLimitKw(s, v),
      allowedKw: targetW / 1000,
    });
    const p: SentProfile = {
      key: `fd-profile-${s.id}-${seq}`,
      body: toProfileInput(sched, {
        transactionId: s.transactionId!,
        startAt: at,
        holdW: targetW,
        stackLevel: stack,
      }),
      w: targetW,
      stack,
      confirmed: false,
    };
    // Stored before the request, so a retry after a crash reuses key and body.
    sent.push(p);
    s.profile = {
      status: "sending",
      seq,
      key: p.key,
      kw: targetW / 1000,
      at: at.toISOString(),
    };
    await save();
    await postProfile(s, p);
    if (p.confirmed) await retireOlder(s, p);
    if (sent.includes(p)) s.profile.composite = await readComposite(s, seq);
    await save();
    await logEvent(
      d,
      `charging_profile.${s.profile.status === "pending" ? "sent" : s.profile.status}`,
      `${name}: ${(targetW / 1000).toFixed(1)} kW${s.profile.detail ? ` (${s.profile.detail})` : ""}`,
    );
  } catch (e) {
    const why = describeError(e);
    show(s, "error", why);
    await save();
    await logEvent(d, "charging_profile.error", `${name}: ${why}`);
  }
}

/**
 * Bring a charger's baseline to `targetW` per connector, the same way a session's
 * profile is changed: a lower limit goes straight out, OCPP 2.x alternates between
 * stack levels 1 and 2 and clears the old profile after the new one is accepted.
 * Never throws.
 */
async function applyBaseline(d: Depot, c: Charger, targetW: number) {
  const sent = (c.sent ??= []);
  const name = `baseline of station ${c.stationId}`;
  const save = () => d.store.put("chargers", c.id, c);
  try {
    for (const p of [...sent]) {
      if (!p.profileId) await postProfile(c, p);
      else if (!p.confirmed) await refreshProfile(c, p);
    }
    await save();
    if (!needsSend(c, targetW)) {
      const latest = sent.at(-1)!;
      if (latest.confirmed) await retireOlder(c, latest);
      await save();
      return;
    }
    let stack = 1;
    if (!isV16(c)) {
      const top = topConfirmed(sent);
      for (const p of sent.filter((x) => x !== top)) await clearProfile(c, p);
      if (sent.some((x) => x !== top)) {
        await save();
        await logEvent(
          d,
          "charging_profile.error",
          `${name}: waiting for the station to clear an earlier profile`,
        );
        return;
      }
      stack = top?.stack === 1 ? 2 : 1;
    }
    const seq = (c.seq ?? 0) + 1;
    c.seq = seq;
    const p: SentProfile = {
      key: `fd-baseline-${c.stationId}-${seq}`,
      body: toBaselineInput(targetW, stack),
      w: targetW,
      stack,
      confirmed: false,
    };
    sent.push(p);
    await save();
    await postProfile(c, p);
    if (p.confirmed) await retireOlder(c, p);
    await save();
    await logEvent(
      d,
      "charging_profile.baseline",
      `${name}: ${(targetW / 1000).toFixed(1)} kW per connector`,
    );
  } catch (e) {
    await save();
    await logEvent(d, "charging_profile.error", `${name}: ${describeError(e)}`);
  }
}

function topConfirmed(sent: SentProfile[]) {
  const c = sent.filter((p) => p.confirmed);
  return c.length
    ? c.reduce((a, b) => (b.stack >= a.stack ? b : a))
    : undefined;
}

/** Forget a profile that is no longer in force (in place: callers hold the array). */
function drop(s: Holder, p: SentProfile) {
  const i = s.sent?.indexOf(p) ?? -1;
  if (i >= 0) s.sent!.splice(i, 1);
}

/** Update what the board shows, when `p` is the session's latest profile. */
function show(
  s: Holder,
  status: ProfileState["status"],
  detail?: string,
  p?: SentProfile,
) {
  if (!s.profile || (p && p.key !== s.profile.key)) return;
  s.profile.status = status;
  s.profile.detail = detail;
  if (p?.profileId) s.profile.profileId = p.profileId;
}

/** POST a profile with its stored key and body, and record the answer. */
async function postProfile(s: Holder, p: SentProfile) {
  const api = ivora();
  let op: Operation;
  try {
    op = await api.setChargingProfile(
      s.stationId,
      p.body as ProfileInput,
      p.key,
    );
  } catch (e) {
    // Refused by the API: nothing was set. Unknown outcome: keep it counted.
    if (!(e instanceof IvoraError && e.retriable)) drop(s, p);
    throw e;
  }
  const r = (op.result ?? {}) as {
    profile_id?: string;
    charger_status?: string | null;
    error?: { code?: string; message?: string };
  };
  p.profileId = r.profile_id ?? p.profileId;
  if (op.status === "rejected") {
    drop(s, p);
    show(
      s,
      "rejected",
      `${r.error?.code ?? "rejected"}: ${r.error?.message ?? ""}`,
      p,
    );
  } else if (r.charger_status === "Accepted") {
    p.confirmed = true;
    show(s, "accepted", undefined, p);
  } else if (r.charger_status) {
    drop(s, p);
    show(s, "rejected", `charger answered ${r.charger_status}`, p);
  } else {
    // The charging_profile.* webhook (or the next replan) brings the answer.
    show(s, "pending", undefined, p);
  }
}

/** Read a profile the charger has not answered yet. Failures leave it counted. */
async function refreshProfile(s: Holder, p: SentProfile) {
  const rec = await ivora()
    .getChargingProfile(s.stationId, p.profileId!)
    .catch(() => undefined);
  if (rec) applyProfileStatus(s, p, rec.status);
}

/** Apply a profile state from the API or a webhook to our record of it. */
export function applyProfileStatus(s: Holder, p: SentProfile, status: string) {
  if (status === "accepted") {
    p.confirmed = true;
    show(s, "accepted", undefined, p);
    // OCPP 1.6: it replaced the earlier profiles at its stack level.
    const before = (s.sent ?? []).slice(0, (s.sent ?? []).indexOf(p));
    if (isV16(s)) for (const x of before) if (x.stack === p.stack) drop(s, x);
  } else if (["rejected", "cleared", "replaced", "ended"].includes(status)) {
    drop(s, p);
    if (status === "rejected") show(s, "rejected", "charger rejected it", p);
  }
  // pending, unknown and no_reply: it may still be in force; keep counting it.
}

/** Once `p` is accepted, remove the profiles it supersedes. */
async function retireOlder(s: Holder, p: SentProfile) {
  const older = (s.sent ?? []).filter((x) => x !== p);
  if (isV16(s)) {
    // Same purpose, connector and stack level: the charger replaced them.
    for (const x of older) if (x.stack === p.stack) drop(s, x);
    return;
  }
  for (const x of older) await clearProfile(s, x);
}

/** Clear a profile by ID; it stays counted until the station confirms. */
async function clearProfile(s: Holder, p: SentProfile) {
  if (!p.profileId) return;
  try {
    const op = await ivora().clearChargingProfile(
      s.stationId,
      p.profileId,
      `fd-clear-${p.profileId}`,
    );
    if (op.status === "succeeded") drop(s, p);
  } catch (e) {
    if (e instanceof IvoraError && e.code === "charging_profile_inactive")
      drop(s, p);
    else throw e;
  }
}

/** Ask the station what it will actually apply, and describe the first period. */
async function readComposite(s: Session, seq: number): Promise<string> {
  const api = ivora();
  try {
    let op: Operation = await api.compositeSchedule(
      s.stationId,
      {
        duration_seconds: 86400,
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
  /** Connectors on the station, when known (the baseline covers all of them). */
  connectorCount?: number;
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
  if (!d.demo && d.settings.baselineProfile) await noteCharger(d, x);
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

/** A charger is added the first time a session starts on it; its baseline follows in the replan. */
async function noteCharger(d: Depot, x: SessionStart) {
  const id = `st-${x.stationId}`;
  const known = (await d.store.list("chargers")).find((c) => c.id === id);
  const units = Math.max(known?.units ?? 0, x.connectorCount ?? 1);
  const c: Charger = known ?? { id, stationId: x.stationId, units };
  c.units = units;
  c.protocol = x.protocol ?? c.protocol;
  await d.store.put("chargers", id, c);
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
