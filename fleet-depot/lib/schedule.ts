import { energyNeededKwh, wholeW, type EnergyNeed } from "./units";

export interface ScheduleInput {
  need: EnergyNeed;
  now: Date;
  departure: Date;
  /** Connector limit in kW. */
  maxKw: number;
  /** Power allowed for this vehicle by the site cap, in kW. Defaults to maxKw. */
  allowedKw?: number;
}

export interface SchedulePeriod {
  /** Seconds from the start of the schedule. */
  startPeriod: number;
  /** Limit in whole W. */
  limit: number;
}

export interface ScheduleResult {
  neededKwh: number;
  chargeKw: number;
  /** Seconds of charging required at chargeKw. */
  chargeSeconds: number;
  availableSeconds: number;
  feasible: boolean;
  periods: SchedulePeriod[];
  /** Energy the schedule delivers by departure, in kWh. */
  deliverableKwh: number;
}

/**
 * Charge as slowly as the deadline allows (smoothest load), capped by connector
 * and allowed power. If the deadline cannot be met the schedule runs at the cap;
 * a vehicle still plugged in after its departure charges at the cap until done.
 * Limits are whole watts, rounded down.
 */
export function computeSchedule(i: ScheduleInput): ScheduleResult {
  const neededKwh = energyNeededKwh(i.need);
  const capW = Math.max(0, wholeW(Math.min(i.maxKw, i.allowedKw ?? i.maxKw)));
  const availableSeconds = Math.max(
    0,
    Math.floor((i.departure.getTime() - i.now.getTime()) / 1000),
  );
  const result = (
    chargeW: number,
    chargeSeconds: number,
    feasible: boolean,
    periods: SchedulePeriod[],
  ): ScheduleResult => ({
    neededKwh,
    chargeKw: chargeW / 1000,
    chargeSeconds,
    availableSeconds,
    feasible,
    periods,
    deliverableKwh:
      (chargeW * Math.min(chargeSeconds, availableSeconds)) / 3_600_000,
  });
  if (neededKwh <= 0 || capW <= 0 || !Number.isFinite(capW))
    return result(0, 0, neededKwh <= 0, [{ startPeriod: 0, limit: 0 }]);
  const neededWs = neededKwh * 3_600_000;
  if (availableSeconds <= 0)
    return result(capW, Math.ceil(neededWs / capW), false, [
      { startPeriod: 0, limit: capW },
    ]);
  const requiredW = Math.ceil(neededWs / availableSeconds);
  const feasible = requiredW <= capW;
  const chargeW = Math.min(requiredW, capW);
  const runSeconds = Math.min(Math.ceil(neededWs / chargeW), availableSeconds);
  const periods: SchedulePeriod[] = [{ startPeriod: 0, limit: chargeW }];
  if (runSeconds < availableSeconds)
    periods.push({ startPeriod: runSeconds, limit: 0 });
  return result(chargeW, runSeconds, feasible, periods);
}

/** API limit on a period's start offset (seconds). */
const MAX_OFFSET_SECONDS = 604800;

/**
 * Ivora charging profile body (POST .../stations/{id}/charging-profiles) for one
 * running transaction: purpose "session", limits in W, absolute from `startAt`.
 *
 * The profile never expires: there is no duration, so the station keeps the last
 * period until the session ends. Every period is at most `holdW` (the session's
 * share of the site cap), and from departure on the limit is `holdW`, so a vehicle
 * that stays past its departure is still capped and never runs unlimited.
 */
export function toProfileInput(
  s: ScheduleResult,
  opts: {
    transactionId: number;
    startAt: Date;
    holdW: number;
    stackLevel?: number;
  },
) {
  const hold = Math.max(0, Math.floor(opts.holdW));
  const periods = s.periods
    .filter((p) => p.startPeriod <= MAX_OFFSET_SECONDS)
    .map((p) => ({
      start_offset_seconds: p.startPeriod,
      limit: Math.min(p.limit, hold),
    }));
  const departure = s.availableSeconds;
  if (
    departure > 0 &&
    departure <= MAX_OFFSET_SECONDS &&
    periods.at(-1)!.limit !== hold
  ) {
    const kept = periods.filter((p) => p.start_offset_seconds < departure);
    kept.push({ start_offset_seconds: departure, limit: hold });
    periods.splice(0, periods.length, ...kept);
  }
  return {
    purpose: "session" as const,
    unit: "W" as const,
    transaction_id: opts.transactionId,
    stack_level: opts.stackLevel ?? 1,
    kind: "absolute" as const,
    start_at: opts.startAt.toISOString(),
    periods,
  };
}

/**
 * Baseline profile body: purpose "tx_default" for every connector of the station,
 * relative to the start of each transaction, no duration. A charger applies it to
 * a new transaction until that transaction's own session profile is in force.
 */
export function toBaselineInput(limitW: number, stackLevel = 1) {
  return {
    purpose: "tx_default" as const,
    unit: "W" as const,
    stack_level: stackLevel,
    kind: "relative" as const,
    periods: [
      { start_offset_seconds: 0, limit: Math.max(0, Math.floor(limitW)) },
    ],
  };
}

/** The highest limit in a profile body, W: what the session may draw at most under it. */
export const maxLimitW = (body: { periods: { limit: number }[] }) =>
  Math.max(0, ...body.periods.map((p) => p.limit));
