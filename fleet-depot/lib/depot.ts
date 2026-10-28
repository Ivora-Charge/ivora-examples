import "server-only";
import { randomUUID } from "node:crypto";
import { config, isDemo } from "./config";
import {
  describeError,
  ivora,
  IvoraError,
  type Operation,
  type ProfileInput,
  type StationRecord,
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

/** The lowest limit that may be in force under these profiles, W (Infinity when none). */
function lowestW(sent: SentProfile[] = []): number {
  return Math.min(
    topConfirmed(sent)?.w ?? Infinity,
    ...sent.filter((p) => !p.confirmed).map((p) => p.w),
  );
}

/**
 * Recompute allocations for all active sessions and apply a charging profile for each
 * whose allocation changed. Called when a vehicle plugs in or leaves, on edits, on
 * webhook answers and on a timer.
 *
 * Lower limits go first. Limits are raised only once every lowered limit is in
 * force at its station; if any decrease fails or is not confirmed yet, the raises
 * wait for the next replan, so a partial update never takes the site over the cap.
 * Every limit is also sized against the site's worst case as it stands at that
 * moment (`worstW`), recomputed before each request.
 */
export async function replan(d: Depot): Promise<void> {
  const at = now(d);
  const baselineOn = !d.demo && !!d.settings.baselineProfile;
  const sessions = await d.store.list("sessions");
  if (baselineOn) await findChargers(d, sessions);
  const vehicles = new Map(
    (await d.store.list("vehicles")).map((v) => [v.id, v]),
  );
  const vehicleOf = (s: Session) =>
    s.vehicleId ? vehicles.get(s.vehicleId) : undefined;
  const capW = wholeW(d.settings.siteCapKw);
  const chargers = baselineOn ? await d.store.list("chargers") : [];
  // A charger's refusal holds until the cap or the set of connectors changes.
  const plan = `${capW} W / ${chargers.reduce((n, c) => n + c.connectors.length, 0)} connectors`;
  const allocate = async () => {
    const base = baselinePlan(capW, chargers, sessions);
    for (const c of chargers) {
      c.shareW = base.shareW;
      c.plan = plan;
      await d.store.put("chargers", c.id, c);
    }
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
  };
  await allocate();
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
  const chargerOf = (s: Session) =>
    chargers.find((c) => c.stationId === s.stationId);
  /**
   * What the whole site may draw right now as far as the app knows, W: every
   * session at the limit that may be in force for it, and every idle connector of a
   * known charger at the baseline that may be in force (its rating when there is
   * none). `extra` adds a baseline about to be sent. Read fresh on every use, so a
   * limit sent earlier in this replan is counted.
   */
  const worstW = (extra?: Extra) =>
    sessions.reduce(
      (sum, s) => sum + reservedW(s, target(s), floorOf(s, extra)),
      0,
    ) + chargers.reduce((sum, c) => sum + idleW(c, sessions, extra), 0);
  const floorOf = (s: Session, extra?: Extra) => {
    const c = chargerOf(s);
    return c ? sessionFloorW(c, s, extra) : 0;
  };
  // A profile is never sent above the cap minus what the rest of the site may
  // draw, so a session that just plugged in only gets what is free while a
  // decrease elsewhere is still on its way.
  const headroom = (s: Session) =>
    capW - worstW() + reservedW(s, target(s), floorOf(s));
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
  const baseOver = (c: Charger) =>
    !heldBack(c, at) && enforcedW(c.sent) > (c.shareW ?? 0);
  // Chosen once the profiles in flight are settled: one that turns out not to be in
  // force can make a decrease a raise.
  // A decrease never goes above a lower limit that may already be in force (sent,
  // not answered yet): at the charger that would be a raise.
  const applyBase = (c: Charger) =>
    applyBaseline(d, c, () =>
      baseOver(c) ? Math.min(c.shareW!, lowestW(c.sent)) : raiseW(c),
    );
  /** The highest baseline up to the share that keeps the worst case within the cap. */
  const raiseW = (c: Charger) => {
    const cur = enforcedW(c.sent);
    const fits = (w: number) =>
      worstW({
        charger: c,
        p: { key: "", body: null, w, stack: 0, confirmed: false },
      }) <= capW;
    let lo = cur;
    let hi = c.shareW!;
    if (fits(hi)) return hi;
    if (!fits(lo)) return cur;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  };

  const lowered = new Set<Session>();
  const loweredBase = new Set<Charger>();
  for (let round = 0; ; round++) {
    const without = chargers.filter(noBaseline).length;
    const changed = () => chargers.filter(noBaseline).length !== without;
    // Baselines first: a session lowered after them is sized against what they free.
    for (const c of chargers)
      if (baseOver(c) && (!loweredBase.has(c) || needsSend(c, c.shareW!))) {
        loweredBase.add(c);
        await applyBase(c);
        if (changed()) break;
      }
    // A charger that refused its baseline is reserved at its rating from now on:
    // split again at once, so nothing more is sent under the old shares.
    if (changed()) {
      await allocate();
      if (round < chargers.length) continue;
    }
    for (const s of live)
      if (over(s) && (!lowered.has(s) || needsSend(s, target(s)))) {
        lowered.add(s);
        await apply(s);
      }
    break;
  }
  const waiting = live.filter(over);
  const waitingBase = chargers.filter(baseOver);
  // A baseline not in force yet holds back only baseline raises: session limits
  // already count it at what may still be in force (or the connector rating).
  const deferred = [
    ...(waiting.length > 0
      ? live.filter((s) => !lowered.has(s) && needsSend(s, target(s)))
      : []),
    ...(waiting.length > 0 || waitingBase.length > 0
      ? chargers.filter(
          (c) =>
            !loweredBase.has(c) && !heldBack(c, at) && needsSend(c, c.shareW!),
        )
      : []),
  ];
  // A limit lowered above, but held below its goal while others made room, is
  // raised here too once every lower limit is in force.
  if (waiting.length === 0) for (const s of live) await apply(s);
  if (waiting.length === 0 && waitingBase.length === 0)
    for (const c of chargers) if (!heldBack(c, at)) await applyBase(c);
  if (deferred.length > 0)
    await logEvent(
      d,
      "plan.deferred",
      `${deferred.length} higher limit(s) wait until the lower limit for ${[
        ...waiting.map((s) => describe(s, vehicleOf(s))),
        ...waitingBase.map((c) => `the baseline of station ${c.stationId}`),
      ].join(", ")} is in force; retried on the next replan`,
    );
}

/** A baseline profile about to be sent for `charger`, counted as may-be-in-force. */
interface Extra {
  charger: Charger;
  p: SentProfile;
}

const sentWith = (c: Charger, extra?: Extra) =>
  extra?.charger === c ? [...(c.sent ?? []), extra.p] : c.sent;

/**
 * Not sent again until the plan changes or an hour has passed: the charger refused
 * a baseline under the current plan, and has none in force or one at or below its
 * share. A refused decrease of a baseline still in force is retried on every
 * replan, like a session's.
 */
const heldBack = (c: Charger, at: Date) =>
  c.refused !== undefined &&
  c.refused.plan === c.plan &&
  at.getTime() - Date.parse(c.refused.at ?? "") < REFUSED_RETRY_MS &&
  (noBaseline(c) || enforcedW(c.sent) <= (c.shareW ?? 0));

/** The charger has no baseline: it refused one and none is in force. */
const noBaseline = (c: Charger) =>
  c.refused !== undefined && !Number.isFinite(enforcedW(c.sent));

/** A connector's rating, W; the highest of the station's for a connector it does not list. */
function ratingW(c: Charger, connectorId?: number): number {
  const w = (x: Charger["connectors"][number]) =>
    x.maxW ?? wholeW(config.defaultConnectorKw);
  const known = c.connectors.find((x) => x.id === connectorId);
  return known ? w(known) : Math.max(0, ...c.connectors.map(w));
}

/**
 * What a new transaction on this connector may draw before its own profile is in
 * force, W: the baseline that may be in force, or the connector rating when no
 * baseline is (the charger's own default).
 */
function perConnectorW(c: Charger, connectorId?: number, extra?: Extra) {
  return Math.min(enforcedW(sentWith(c, extra)), ratingW(c, connectorId));
}

/**
 * The least a session may draw until its own profile is in force, W. A charger may
 * apply the baseline in force when the transaction started, or the current one.
 */
function sessionFloorW(c: Charger, s: Session, extra?: Extra) {
  return Math.max(
    s.startBaselineW ?? ratingW(c, s.connectorId),
    perConnectorW(c, s.connectorId, extra),
  );
}

/** The charger's connectors without a session. */
function idleConnectors(c: Charger, sessions: Session[]) {
  const here = sessions.filter((s) => s.stationId === c.stationId);
  const idle = c.connectors.filter(
    (x) => !here.some((s) => s.connectorId === x.id),
  );
  // A session on a connector the station record does not list takes one of the
  // idle ones: drop the lowest rated, so the reserve errs on the high side.
  const unlisted = here.filter(
    (s) => !c.connectors.some((x) => x.id === s.connectorId),
  ).length;
  return idle
    .sort((a, b) => ratingW(c, b.id) - ratingW(c, a.id))
    .slice(0, Math.max(0, idle.length - unlisted));
}

/** What the charger's idle connectors may draw if a vehicle plugs in, W. */
const idleW = (c: Charger, sessions: Session[], extra?: Extra) =>
  idleConnectors(c, sessions).reduce(
    (sum, x) => sum + perConnectorW(c, x.id, extra),
    0,
  );

/**
 * The baseline arithmetic of one plan (empty when the baseline is off). A charger
 * without a baseline keeps its connectors at their rating; every connector of the
 * other known chargers gets an equal share of what is left of the cap, rounded down
 * to whole watts. `idleW` is what the connectors without a session may draw under
 * that plan, so the sessions are planned within the cap minus that: a vehicle
 * plugging in then draws its baseline at most, and the site stays under the cap.
 */
function baselinePlan(capW: number, chargers: Charger[], sessions: Session[]) {
  const fixed = chargers.filter(noBaseline);
  const fixedW = fixed.reduce(
    (sum, c) => sum + c.connectors.reduce((n, x) => n + ratingW(c, x.id), 0),
    0,
  );
  const units = chargers
    .filter((c) => !fixed.includes(c))
    .reduce((n, c) => n + c.connectors.length, 0);
  const shareW =
    units > 0 ? Math.max(0, Math.floor((capW - fixedW) / units)) : 0;
  const idle = (c: Charger) =>
    idleConnectors(c, sessions).reduce(
      (sum, x) =>
        sum +
        (fixed.includes(c)
          ? ratingW(c, x.id)
          : Math.min(shareW, ratingW(c, x.id))),
      0,
    );
  return {
    shareW,
    idleW: chargers.reduce((sum, c) => sum + idle(c), 0),
  };
}

const maxSentW = (s: { sent?: SentProfile[] }) =>
  Math.max(0, ...(s.sent ?? []).map((p) => p.w));

/**
 * What a session may draw as far as the app knows, W. A session without an
 * accepted profile counts at the most it was sent, or else at its allocation, and
 * at least at `floorW` (what the charger lets it draw until then: its baseline).
 */
function reservedW(
  s: { sent?: SentProfile[] },
  targetW: number,
  floorW = 0,
): number {
  const b = enforcedW(s.sent);
  if (Number.isFinite(b)) return b;
  return Math.max(floorW, s.sent?.length ? maxSentW(s) : targetW);
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
      else if (!p.confirmed) await refreshProfile(s, p, at);
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

/** Error codes for a charger that cannot take a baseline profile at all. */
const UNSUPPORTED = new Set([
  "smart_charging_unsupported",
  "charging_profile_unsupported",
]);

/** How long a charger that refused its baseline waits before it is sent again. */
const REFUSED_RETRY_MS = 3600_000;

/**
 * Record that the charger refused its baseline under the current plan: it is not
 * sent again until the cap or the connectors change, or an hour has passed.
 */
function refuse(c: Charger, why: string, at: Date) {
  c.refused = { plan: c.plan, why, at: at.toISOString() };
}

/**
 * Bring a charger's baseline to `goal()` per connector, the same way a session's
 * profile is changed: a lower limit goes straight out, OCPP 2.x alternates between
 * stack levels 1 and 2 and clears the old profile after the new one is accepted.
 * A rejection, or an answer that the charger does not support it, marks the charger
 * as refused. Never throws.
 */
async function applyBaseline(d: Depot, c: Charger, goal: () => number) {
  const sent = (c.sent ??= []);
  const name = `baseline of station ${c.stationId}`;
  const save = () => d.store.put("chargers", c.id, c);
  const refused = async (why: string) => {
    refuse(c, why, now(d));
    await save();
    await logEvent(
      d,
      "charging_profile.baseline_refused",
      `${name}: ${why}. Its connectors are reserved at their rating; sent again in an hour, or sooner when the cap or the chargers change`,
    );
  };
  try {
    for (const p of [...sent]) {
      if (!p.profileId) {
        const notSet = await postProfile(c, p);
        if (notSet.refused) refuse(c, notSet.refused, now(d));
      } else if (!p.confirmed) await refreshProfile(c, p, now(d));
    }
    await save();
    if (heldBack(c, now(d))) return;
    let targetW = goal();
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
      // A cleared profile no longer counts: what was a decrease may now be a raise.
      targetW = goal();
      if (!needsSend(c, targetW)) return await save();
    }
    const seq = (c.seq ?? 0) + 1;
    c.seq = seq;
    const p: SentProfile = {
      key: `fd-baseline-${c.stationId}-${c.keyId}-${seq}`,
      body: toBaselineInput(targetW, stack),
      w: targetW,
      stack,
      confirmed: false,
    };
    sent.push(p);
    await save();
    const notSet = await postProfile(c, p);
    if (notSet.refused) return await refused(notSet.refused);
    if (notSet.failed) {
      // Not refused: sent again on the next replan, counted at the rating meanwhile.
      await save();
      return await logEvent(
        d,
        "charging_profile.error",
        `${name}: not set (${notSet.failed}); retried on the next replan`,
      );
    }
    if (p.confirmed) {
      delete c.refused;
      await retireOlder(c, p);
    }
    await save();
    await logEvent(
      d,
      "charging_profile.baseline",
      `${name}: ${(targetW / 1000).toFixed(1)} kW per connector`,
    );
  } catch (e) {
    if (e instanceof IvoraError && UNSUPPORTED.has(e.code))
      return await refused(describeError(e));
    await save();
    await logEvent(
      d,
      "charging_profile.error",
      `${name}: ${describeError(e)}; retried on the next replan`,
    );
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

/**
 * What became of a profile that was not set. `refused`: the charger answered with
 * anything but Accepted, or the API says it cannot take profiles. `failed`: it never
 * reached the charger (offline, a dispatch error), so it is worth sending again.
 */
type NotSet = { refused?: string; failed?: string };

/** POST a profile with its stored key and body, and record the answer. */
async function postProfile(s: Holder, p: SentProfile): Promise<NotSet> {
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
    const code = r.error?.code ?? "rejected";
    const why = `${code}: ${r.error?.message ?? ""}`;
    show(s, "rejected", why, p);
    // station_offline and other dispatch errors: the charger never saw it.
    return UNSUPPORTED.has(code) ? { refused: why } : { failed: why };
  } else if (r.charger_status === "Accepted") {
    p.confirmed = true;
    show(s, "accepted", undefined, p);
  } else if (r.charger_status) {
    drop(s, p);
    const why = `charger answered ${r.charger_status}`;
    show(s, "rejected", why, p);
    return { refused: why };
  } else {
    // The charging_profile.* webhook (or the next replan) brings the answer.
    show(s, "pending", undefined, p);
  }
  return {};
}

/** Read a profile the charger has not answered yet. Failures leave it counted. */
async function refreshProfile(s: Holder, p: SentProfile, at: Date) {
  const rec = await ivora()
    .getChargingProfile(s.stationId, p.profileId!)
    .catch(() => undefined);
  if (rec) applyProfileStatus(s, p, rec.status, at, rec.error?.code);
}

/**
 * Apply a profile state from the API or a webhook to our record of it. A rejected
 * baseline marks its charger as refused, unless `errorCode` says it never reached
 * the charger (station_offline, a dispatch error): then it is sent again.
 */
export function applyProfileStatus(
  s: Holder,
  p: SentProfile,
  status: string,
  at: Date,
  errorCode?: string,
) {
  const charger = "connectors" in s ? (s as Charger) : undefined;
  if (status === "accepted") {
    p.confirmed = true;
    if (charger) delete charger.refused;
    show(s, "accepted", undefined, p);
    // OCPP 1.6: it replaced the earlier profiles at its stack level.
    const before = (s.sent ?? []).slice(0, (s.sent ?? []).indexOf(p));
    if (isV16(s)) for (const x of before) if (x.stack === p.stack) drop(s, x);
  } else if (["rejected", "cleared", "replaced", "ended"].includes(status)) {
    drop(s, p);
    if (status === "rejected") show(s, "rejected", "charger rejected it", p);
    if (
      status === "rejected" &&
      charger &&
      (!errorCode || UNSUPPORTED.has(errorCode))
    )
      refuse(charger, errorCode ?? "the charger rejected it", at);
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
  /**
   * Every connector of the station with its rating, W, when the station could be
   * read. The baseline covers all of them; without this list the charger is not
   * added yet (the next replan reads the station again).
   */
  connectors?: Charger["connectors"];
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
  if (!d.demo && d.settings.baselineProfile) {
    if (x.connectors)
      await noteCharger(d, x.stationId, x.protocol, x.connectors);
    const c = (await d.store.list("chargers")).find(
      (y) => y.stationId === x.stationId,
    );
    // Counted until the session's own profile is in force.
    if (c) s.startBaselineW = perConnectorW(c, x.connectorId);
  }
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

/**
 * A charger is added the first time a session starts on it, once its connectors are
 * known; its baseline follows in the replan.
 */
async function noteCharger(
  d: Depot,
  stationId: number,
  protocol: string | undefined,
  connectors: Charger["connectors"],
) {
  if (connectors.length === 0) return;
  const id = `st-${stationId}`;
  const known = (await d.store.list("chargers")).find((c) => c.id === id);
  const c: Charger = known ?? {
    id,
    stationId,
    connectors: [],
    keyId: randomUUID(),
  };
  for (const x of connectors) {
    const had = c.connectors.find((y) => y.id === x.id);
    if (had) had.maxW = x.maxW;
    else c.connectors.push({ ...x });
  }
  c.protocol = protocol ?? c.protocol;
  await d.store.put("chargers", id, c);
}

/** When a failed station read was last logged, per depot and station (ms). */
const lookupLogged = new WeakMap<Depot, Map<number, number>>();

/** A station that never answers is logged once an hour, not on every replan. */
const LOOKUP_LOG_MS = 3600_000;

/**
 * Add the chargers of sessions whose station could not be read when they started.
 * Until then their connectors are not in the split and have no baseline.
 */
async function findChargers(d: Depot, sessions: Session[]) {
  if (!lookupLogged.has(d)) lookupLogged.set(d, new Map());
  const logged = lookupLogged.get(d)!;
  const known = new Set(
    (await d.store.list("chargers")).map((c) => c.stationId),
  );
  const missing = new Set(
    sessions
      .filter((s) => s.transactionId && !known.has(s.stationId))
      .map((s) => s.stationId),
  );
  for (const stationId of missing) {
    try {
      const st = await ivora().getStation(stationId);
      await noteCharger(
        d,
        stationId,
        st.protocol ?? undefined,
        stationConnectors(st),
      );
      logged.delete(stationId);
    } catch (e) {
      const at = now(d).getTime();
      const last = logged.get(stationId);
      if (last !== undefined && at - last < LOOKUP_LOG_MS) continue;
      logged.set(stationId, at);
      await logEvent(
        d,
        "charging_profile.error",
        `baseline of station ${stationId}: connectors unknown (${describeError(e)}); retried on every replan, logged once an hour`,
      );
    }
  }
}

/** A station's connectors with their rating, W. */
export const stationConnectors = (st: StationRecord): Charger["connectors"] =>
  st.connectors.map((c) => ({ id: c.id, maxW: c.max_power_w ?? null }));

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

/** The currency and per-kWh price for a vehicle's tariff id (the default tariff when unset). */
export function rateOf(settings: Settings, tariffId?: string) {
  const t = tariffId && settings.tariffs?.find((x) => x.id === tariffId);
  return t
    ? { currency: t.currency, minorPerKwh: t.minorPerKwh }
    : { currency: settings.currency, minorPerKwh: settings.centsPerKwh };
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
  const tariffOf = new Map<string, string | undefined>(
    vehicles.map((v) => [v.id, v.tariffId]),
  );
  return buildReport(
    txs as TxRecord[],
    month,
    (t) => rateOf(d.settings, tariffOf.get(t.vehicleId)),
    by,
    labels,
  );
}
