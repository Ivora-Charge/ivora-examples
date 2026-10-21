import { describe, expect, it } from "vitest";
import {
  axisFor,
  chargeSpans,
  LABEL_PCT,
  hourTicks,
  miniLabels,
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

describe("phone mini-timeline labels", () => {
  // Label boxes in % of the track, from the anchor and alignment.
  const box = (left: number, align: string, w: number) =>
    align === "end"
      ? [left - w, left]
      : align === "middle"
        ? [left - w / 2, left + w / 2]
        : [left, left + w];

  it("never lets start and departure touch, and keeps every label on the track", () => {
    for (let now = 0; now <= 100; now += 2.5) {
      for (const dep of [undefined, 0, 5, 20, 30, 50, 52, 60, 90, 100]) {
        const l = miniLabels(now, dep);
        const n = box(l.now.left, l.now.align, LABEL_PCT.now);
        expect(n[0]).toBeGreaterThanOrEqual(0);
        expect(n[1]).toBeLessThanOrEqual(100);
        if (!l.dep) continue;
        const d = box(l.dep.left, l.dep.align, LABEL_PCT.dep);
        expect(d[0]).toBeGreaterThanOrEqual(0);
        expect(d[1]).toBeLessThanOrEqual(100);
        if (l.start) expect(d[0]).toBeGreaterThanOrEqual(LABEL_PCT.start);
      }
    }
  });

  it("keeps all three labels when now is close to start (19:00, now 21:30)", () => {
    const l = miniLabels(21, 92);
    expect(l.start).toBe(true);
    expect(l.dep?.align).toBe("end");
  });
});
