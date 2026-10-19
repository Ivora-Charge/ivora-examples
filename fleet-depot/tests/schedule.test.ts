import { describe, expect, it } from "vitest";
import { computeSchedule, toChargingProfile } from "@/lib/schedule";
import {
  costCents,
  energyNeededKwh,
  sessionKwhFromRegisters,
} from "@/lib/units";

const now = new Date("2026-01-01T18:00:00Z");
const dep = (h: number) => new Date(now.getTime() + h * 3600_000);

describe("energy need", () => {
  it("uses kWh directly", () =>
    expect(energyNeededKwh({ kind: "kwh", kwh: 30 })).toBe(30));
  it("derives kWh from battery size and percent", () =>
    expect(
      energyNeededKwh({
        kind: "battery",
        batteryKwh: 80,
        currentPercent: 20,
        targetPercent: 90,
      }),
    ).toBeCloseTo(56));
  it("is never negative", () =>
    expect(
      energyNeededKwh({
        kind: "battery",
        batteryKwh: 80,
        currentPercent: 95,
        targetPercent: 90,
      }),
    ).toBe(0));
});

describe("Wh registers", () => {
  it("converts meter registers in Wh to kWh", () =>
    expect(sessionKwhFromRegisters(1_000_000, 1_042_500)).toBe(42.5));
  it("ignores a register that went backwards", () =>
    expect(sessionKwhFromRegisters(500, 100)).toBe(0));
  it("prices in integer cents", () => expect(costCents(42.5, 28)).toBe(1190));
});

describe("computeSchedule", () => {
  it("charges slowly when time allows (kW = kWh / h)", () => {
    const s = computeSchedule({
      need: { kind: "kwh", kwh: 40 },
      now,
      departure: dep(10),
      maxKw: 11,
    });
    expect(s.feasible).toBe(true);
    expect(s.chargeKw).toBeCloseTo(4);
    expect(s.periods[0].limit).toBe(4000);
    expect(s.deliverableKwh).toBeCloseTo(40, 1);
  });
  it("runs at the cap and flags infeasible when the deadline is too tight", () => {
    const s = computeSchedule({
      need: { kind: "kwh", kwh: 100 },
      now,
      departure: dep(4),
      maxKw: 11,
    });
    expect(s.feasible).toBe(false);
    expect(s.chargeKw).toBe(11);
    expect(s.deliverableKwh).toBeCloseTo(44, 1);
  });
  it("respects the site allowance", () => {
    const s = computeSchedule({
      need: { kind: "kwh", kwh: 40 },
      now,
      departure: dep(10),
      maxKw: 11,
      allowedKw: 2,
    });
    expect(s.chargeKw).toBe(2);
    expect(s.feasible).toBe(false);
  });
  it("returns a zero-limit schedule when nothing is needed", () => {
    const s = computeSchedule({
      need: { kind: "kwh", kwh: 0 },
      now,
      departure: dep(5),
      maxKw: 11,
    });
    expect(s.periods).toEqual([{ startPeriod: 0, limit: 0 }]);
    expect(s.feasible).toBe(true);
  });
  it("builds a W-based absolute profile", () => {
    const s = computeSchedule({
      need: { kind: "kwh", kwh: 40 },
      now,
      departure: dep(10),
      maxKw: 11,
    });
    const p = toChargingProfile(s, {
      profileId: 7,
      startSchedule: now,
      durationSeconds: s.availableSeconds,
    });
    expect(p.chargingSchedule.chargingRateUnit).toBe("W");
    expect(p.chargingProfileKind).toBe("Absolute");
  });
});
