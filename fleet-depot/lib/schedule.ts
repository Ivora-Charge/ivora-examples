import { energyNeededKwh, type EnergyNeed } from "./units";

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
  /** Limit in W. */
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
 * and allowed power. If the deadline cannot be met the schedule runs at the cap.
 */
export function computeSchedule(i: ScheduleInput): ScheduleResult {
  const neededKwh = energyNeededKwh(i.need);
  const cap = Math.max(0, Math.min(i.maxKw, i.allowedKw ?? i.maxKw));
  const availableSeconds = Math.max(
    0,
    Math.floor((i.departure.getTime() - i.now.getTime()) / 1000),
  );
  if (neededKwh <= 0 || cap <= 0 || availableSeconds <= 0) {
    return {
      neededKwh,
      chargeKw: 0,
      chargeSeconds: 0,
      availableSeconds,
      feasible: neededKwh <= 0,
      periods: [{ startPeriod: 0, limit: 0 }],
      deliverableKwh: 0,
    };
  }
  const requiredKw = (neededKwh * 3600) / availableSeconds;
  const feasible = requiredKw <= cap + 1e-9;
  const chargeKw = feasible ? requiredKw : cap;
  const chargeSeconds = Math.ceil((neededKwh * 3600) / chargeKw);
  const runSeconds = Math.min(chargeSeconds, availableSeconds);
  const periods: SchedulePeriod[] = [
    { startPeriod: 0, limit: Math.round(chargeKw * 1000) },
  ];
  if (runSeconds < availableSeconds)
    periods.push({ startPeriod: runSeconds, limit: 0 });
  return {
    neededKwh,
    chargeKw,
    chargeSeconds: runSeconds,
    availableSeconds,
    feasible,
    periods,
    deliverableKwh: (chargeKw * runSeconds) / 3600,
  };
}

/** API limits on a profile schedule (seconds). */
const MAX_DURATION_SECONDS = 604800;

/**
 * Ivora charging profile body (POST .../stations/{id}/charging-profiles) for one
 * running transaction: purpose "session", limits in W, absolute from `startAt`.
 */
export function toProfileInput(
  s: ScheduleResult,
  opts: { transactionId: number; startAt: Date; stackLevel?: number },
) {
  const duration = Math.min(
    Math.max(1, s.availableSeconds),
    MAX_DURATION_SECONDS,
  );
  return {
    purpose: "session" as const,
    unit: "W" as const,
    transaction_id: opts.transactionId,
    stack_level: opts.stackLevel ?? 1,
    kind: "absolute" as const,
    start_at: opts.startAt.toISOString(),
    duration_seconds: duration,
    periods: s.periods
      .filter((p) => p.startPeriod < duration)
      .map((p) => ({ start_offset_seconds: p.startPeriod, limit: p.limit })),
  };
}
