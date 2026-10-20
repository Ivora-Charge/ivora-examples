import { describe, expect, it } from "vitest";
import { computeSchedule, toProfileInput } from "@/lib/schedule";
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
  it("builds an open-ended Ivora session profile in W, absolute from now", () => {
    const s = computeSchedule({
      need: { kind: "kwh", kwh: 20 },
      now,
      departure: dep(10),
      maxKw: 11,
    });
    const p = toProfileInput(s, {
      transactionId: 31,
      startAt: now,
      holdW: 2000,
    });
    expect(p).toMatchObject({
      purpose: "session",
      unit: "W",
      transaction_id: 31,
      kind: "absolute",
      start_at: now.toISOString(),
    });
    // No duration: the station keeps the last period until the session ends.
    expect(p).not.toHaveProperty("duration_seconds");
    // 20 kWh over 10 h is 2 kW for the whole window, and 2 kW after departure.
    expect(p.periods).toEqual([{ start_offset_seconds: 0, limit: 2000 }]);
  });
  it("holds the site allocation after departure instead of expiring", () => {
    const s = computeSchedule({
      need: { kind: "kwh", kwh: 11 },
      now,
      departure: dep(10),
      maxKw: 11,
      allowedKw: 7.4,
    });
    // 11 kWh over 10 h is 1.1 kW; from departure on, the 7.4 kW share holds.
    const p = toProfileInput(s, {
      transactionId: 1,
      startAt: now,
      holdW: 7400,
    });
    expect(p.periods).toEqual([
      { start_offset_seconds: 0, limit: 1100 },
      { start_offset_seconds: 36000, limit: 7400 },
    ]);
  });
  it("never puts a period above the allocation", () => {
    const s = computeSchedule({
      need: { kind: "kwh", kwh: 80 },
      now,
      departure: dep(2),
      maxKw: 22,
    });
    const p = toProfileInput(s, {
      transactionId: 1,
      startAt: now,
      holdW: 5000,
    });
    expect(Math.max(...p.periods.map((x) => x.limit))).toBe(5000);
  });
  it("charges a vehicle still plugged in after its departure at the cap, with no expiry", () => {
    const s = computeSchedule({
      need: { kind: "kwh", kwh: 10 },
      now,
      departure: dep(-1),
      maxKw: 11,
      allowedKw: 6,
    });
    expect(s.feasible).toBe(false);
    expect(s.chargeKw).toBe(6);
    const p = toProfileInput(s, {
      transactionId: 1,
      startAt: now,
      holdW: 6000,
    });
    expect(p.periods).toEqual([{ start_offset_seconds: 0, limit: 6000 }]);
    expect(p).not.toHaveProperty("duration_seconds");
  });
  it("keeps integer W limits and offsets within the API's 7 days", () => {
    const s = computeSchedule({
      need: { kind: "kwh", kwh: 11 },
      now,
      departure: dep(24 * 10),
      maxKw: 11,
      allowedKw: 11,
    });
    const p = toProfileInput(s, {
      transactionId: 1,
      startAt: now,
      holdW: 11000,
    });
    expect(p.periods[0].limit).toBeGreaterThan(0);
    expect(p.periods.every((x) => Number.isInteger(x.limit))).toBe(true);
    expect(p.periods.every((x) => x.start_offset_seconds <= 604800)).toBe(true);
  });
  it("rounds limits down to whole watts", () => {
    const s = computeSchedule({
      need: { kind: "kwh", kwh: 100 },
      now,
      departure: dep(1),
      maxKw: 11,
      allowedKw: 3.3339,
    });
    expect(s.periods[0].limit).toBe(3333);
  });
});
