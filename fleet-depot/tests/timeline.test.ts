import { describe, expect, it } from "vitest";
import {
  axisFor,
  chargeSpans,
  hourTicks,
  pct,
  statusOf,
} from "../lib/timeline";

const H = 3600_000;
const t0 = Date.UTC(2026, 0, 1, 17, 30);

describe("timeline axis", () => {
  it("spans whole hours from now to the last departure", () => {
    const a = axisFor(t0, [new Date(t0 + 12.2 * H).toISOString()]);
    expect(a.start).toBe(Date.UTC(2026, 0, 1, 15));
    expect(a.end).toBe(Date.UTC(2026, 0, 2, 6));
  });

  it("is at least eight hours wide and ignores missing departures", () => {
    const a = axisFor(t0, [undefined, "nonsense"]);
    expect(a.end - a.start).toBeGreaterThanOrEqual(8 * H);
  });

  it("clamps positions and thins ticks", () => {
    const a = axisFor(t0, [new Date(t0 + 14 * H).toISOString()]);
    expect(pct(a.start - H, a)).toBe(0);
    expect(pct(a.end + H, a)).toBe(100);
    expect(hourTicks(a, 8).length).toBeLessThanOrEqual(9);
  });
});

describe("charge spans", () => {
  const a = axisFor(t0, [new Date(t0 + 10 * H).toISOString()]);

  it("draws delivered energy before now and the plan after it", () => {
    const { done, plan } = chargeSpans(
      t0,
      a,
      { allocatedKw: 10, deliveredKwh: 10 },
      20,
    );
    expect(done!.width).toBeCloseTo(pct(t0, a) - pct(t0 - H, a));
    expect(plan!.left).toBeCloseTo(pct(t0, a));
    expect(plan!.width).toBeCloseTo(pct(t0 + 2 * H, a) - pct(t0, a));
  });

  it("draws nothing without power", () => {
    expect(chargeSpans(t0, a, { allocatedKw: 0, deliveredKwh: 5 }, 5)).toEqual({
      done: undefined,
      plan: undefined,
    });
  });
});

describe("status", () => {
  it("is never colour alone: four distinct states", () => {
    expect(statusOf({})).toBe("waiting");
    expect(statusOf({ session: {}, readyBy: false, remainingKwh: 9 })).toBe(
      "late",
    );
    expect(statusOf({ session: {}, readyBy: true, remainingKwh: 0 })).toBe(
      "ready",
    );
    expect(statusOf({ session: {}, readyBy: true, remainingKwh: 9 })).toBe(
      "charging",
    );
  });
});
