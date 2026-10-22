/** Geometry and wording for the departure timeline. Pure, so it is unit tested. */

const HOUR = 3600_000;

export interface Axis {
  /** ms epoch of the left edge (a whole hour). */
  start: number;
  /** ms epoch of the right edge (a whole hour). */
  end: number;
}

/** A whole-hour axis from two hours before now to just after the last departure (at least 8 h wide). */
export function axisFor(
  nowMs: number,
  departures: (string | undefined)[],
): Axis {
  const times = departures
    .map((d) => (d ? Date.parse(d) : NaN))
    .filter((t) => Number.isFinite(t));
  // Two hours of history, so energy already delivered has room to show.
  const start = Math.floor(nowMs / HOUR) * HOUR - 2 * HOUR;
  const last = Math.max(nowMs + 6 * HOUR, ...times);
  return { start, end: Math.ceil(last / HOUR) * HOUR };
}

/** Position on the axis as a 0-100 percentage, clamped. */
export function pct(ms: number, a: Axis): number {
  return Math.min(100, Math.max(0, ((ms - a.start) / (a.end - a.start)) * 100));
}

/** Hour ticks to label, thinned so that no more than `max` are drawn. */
export function hourTicks(a: Axis, max = 8): number[] {
  const hours = (a.end - a.start) / HOUR;
  const step = Math.max(1, Math.ceil(hours / max));
  const out: number[] = [];
  for (let t = a.start; t <= a.end; t += step * HOUR) out.push(t);
  return out;
}

/**
 * The charge already delivered, drawn backwards from now at the power it
 * has now (an estimate: the state carries energy, not the start time), and the
 * plan from now until the remaining energy is delivered at that power.
 */
export function chargeSpans(
  nowMs: number,
  a: Axis,
  s: { allocatedKw: number; deliveredKwh: number },
  remainingKwh: number | undefined,
) {
  if (s.allocatedKw <= 0) return { done: undefined, plan: undefined };
  const doneFrom = nowMs - (s.deliveredKwh / s.allocatedKw) * HOUR;
  const planTo = nowMs + ((remainingKwh ?? 0) / s.allocatedKw) * HOUR;
  const span = (from: number, to: number) =>
    to - from > 0
      ? { left: pct(from, a), width: pct(to, a) - pct(from, a) }
      : undefined;
  return { done: span(doneFrom, nowMs), plan: span(nowMs, planTo) };
}

export type Align = "start" | "middle" | "end";

/** Label widths in % of a phone track, measured at 360 px wide (310 px track, 11 px mono) plus a margin. */
export const LABEL_PCT = { start: 26, dep: 22, now: 22 };

/**
 * Where the phone mini-timeline labels go. "now" sits above the bar, so it
 * never meets the others. Below it, "start" is on the left and the departure
 * label anchors on its tick, facing away from the nearer edge; "start" is
 * dropped when the two would touch.
 */
export function miniLabels(nowPct: number, depPct?: number) {
  const now: { left: number; align: Align } = {
    left: nowPct,
    align:
      nowPct < LABEL_PCT.now / 2
        ? "start"
        : nowPct > 100 - LABEL_PCT.now / 2
          ? "end"
          : "middle",
  };
  if (depPct === undefined) return { now, start: true, dep: undefined };
  const depAlign: Align = depPct >= LABEL_PCT.dep ? "end" : "start";
  const depFrom = depAlign === "end" ? depPct - LABEL_PCT.dep : depPct;
  return {
    now,
    start: depFrom >= LABEL_PCT.start,
    dep: { left: depPct, align: depAlign },
  };
}

export type VehicleStatus = "charging" | "waiting" | "ready" | "late";

export function statusOf(r: {
  session?: unknown;
  remainingKwh?: number;
  readyBy?: boolean;
  /** Demo: how the vehicle left, once its session ended at departure. */
  departed?: { ready: boolean };
}): VehicleStatus {
  if (!r.session && r.departed) return r.departed.ready ? "ready" : "late";
  if (!r.session) return "waiting";
  if (r.readyBy === false) return "late";
  if (r.remainingKwh !== undefined && r.remainingKwh <= 0.05) return "ready";
  return "charging";
}

export const STATUS_LABEL: Record<VehicleStatus, string> = {
  charging: "charging",
  waiting: "waiting",
  ready: "ready",
  late: "at risk",
};

export const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
