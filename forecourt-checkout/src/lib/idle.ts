import { roundHalfUp } from "./money";

export type IdleTiming = {
  idleSince: string;
  /** When the idle fee starts: idleSince + grace. */
  feeStartsAt: string;
  /** Seconds left before the fee starts; 0 once it has. */
  secondsUntilFee: number;
  accruing: boolean;
  /** Billable idle so far, after the grace period. */
  billableSeconds: number;
  /** Estimate of the idle fee so far, in cents (half up). The bill is final. */
  accruedCents: number;
};

/**
 * Charging has ended but the car is still plugged in. The driver gets
 * `graceMinutes` to move it; after that the idle fee accrues per started
 * `stepSeconds` (the tariff's PARKING_TIME step), as Ivora bills it.
 */
export function idleFeeTiming(input: {
  idleSince: string;
  graceMinutes: number;
  idleCentsPerHour: number;
  stepSeconds?: number;
  now: number;
}): IdleTiming {
  const since = Date.parse(input.idleSince);
  if (Number.isNaN(since)) throw new Error("idleSince must be ISO 8601.");
  if (!Number.isInteger(input.graceMinutes) || input.graceMinutes < 0)
    throw new Error("graceMinutes must be a non-negative whole number.");
  const step = Math.max(1, Math.floor(input.stepSeconds ?? 1));
  const feeStarts = since + input.graceMinutes * 60_000;
  const idleSeconds = Math.max(0, Math.floor((input.now - since) / 1000));
  const graceSeconds = input.graceMinutes * 60;
  const billable = Math.max(0, idleSeconds - graceSeconds);
  const billed = Math.ceil(billable / step) * step;
  const accruing = input.now >= feeStarts && input.idleCentsPerHour > 0;
  return {
    idleSince: new Date(since).toISOString(),
    feeStartsAt: new Date(feeStarts).toISOString(),
    secondsUntilFee: Math.max(0, Math.ceil((feeStarts - input.now) / 1000)),
    accruing,
    billableSeconds: billable,
    accruedCents:
      input.idleCentsPerHour > 0
        ? Number(
            roundHalfUp(
              BigInt(Math.round(input.idleCentsPerHour)) * BigInt(billed),
              3600n,
            ),
          )
        : 0,
  };
}
