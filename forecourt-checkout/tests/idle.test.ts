import { describe, expect, it } from "vitest";
import { idleFeeTiming } from "@/lib/idle";

const since = "2026-10-19T12:00:00.000Z";
const at = (seconds: number) => Date.parse(since) + seconds * 1000;
const base = {
  idleSince: since,
  graceMinutes: 10,
  idleCentsPerHour: 2400,
  stepSeconds: 60,
};

describe("idle-fee timing", () => {
  it("counts down the grace period after charging ends", () => {
    const t = idleFeeTiming({ ...base, now: at(0) });
    expect(t.feeStartsAt).toBe("2026-10-19T12:10:00.000Z");
    expect(t.secondsUntilFee).toBe(600);
    expect(t.accruing).toBe(false);
    expect(t.accruedCents).toBe(0);
    expect(idleFeeTiming({ ...base, now: at(599.2) }).secondsUntilFee).toBe(1);
  });

  it("starts the fee exactly when the grace period ends", () => {
    const t = idleFeeTiming({ ...base, now: at(600) });
    expect(t.secondsUntilFee).toBe(0);
    expect(t.accruing).toBe(true);
    expect(t.billableSeconds).toBe(0);
    expect(t.accruedCents).toBe(0);
  });

  it("bills per started step after the grace period, like the tariff", () => {
    // 61 s billable, 60 s steps -> 120 s billed at $24/h = 80c
    expect(idleFeeTiming({ ...base, now: at(661) }).accruedCents).toBe(80);
    // exactly one step
    expect(idleFeeTiming({ ...base, now: at(660) }).accruedCents).toBe(40);
  });

  it("rounds the running idle estimate half up", () => {
    // 45c/h for 40 s = 0.5c -> 1c; 39 s = 0.4875c -> 0c
    const t = {
      ...base,
      graceMinutes: 0,
      idleCentsPerHour: 45,
      stepSeconds: 1,
    };
    expect(idleFeeTiming({ ...t, now: at(40) }).accruedCents).toBe(1);
    expect(idleFeeTiming({ ...t, now: at(39) }).accruedCents).toBe(0);
  });

  it("never accrues when the tariff has no idle price", () => {
    const t = idleFeeTiming({ ...base, idleCentsPerHour: 0, now: at(3600) });
    expect(t.accruing).toBe(false);
    expect(t.accruedCents).toBe(0);
  });

  it("starts at once with no grace period", () => {
    const t = idleFeeTiming({ ...base, graceMinutes: 0, now: at(0) });
    expect(t.accruing).toBe(true);
    expect(t.secondsUntilFee).toBe(0);
  });

  it("rejects bad input", () => {
    expect(() =>
      idleFeeTiming({ ...base, idleSince: "yesterday", now: at(0) }),
    ).toThrow();
    expect(() =>
      idleFeeTiming({ ...base, graceMinutes: -1, now: at(0) }),
    ).toThrow();
    expect(() =>
      idleFeeTiming({ ...base, graceMinutes: 1.5, now: at(0) }),
    ).toThrow();
  });
});
