import { describe, expect, it } from "vitest";
import {
  applicationFeeCents,
  idleGraceCreditCents,
  MINIMUM_CHARGE_CENTS,
  parseBasisPoints,
  parseDecimal,
  roundHalfUp,
  settle,
} from "@/lib/money";

describe("roundHalfUp", () => {
  it("rounds exact halves up and everything else to nearest", () => {
    expect(roundHalfUp(5n, 10n)).toBe(1n); // 0.5
    expect(roundHalfUp(4n, 10n)).toBe(0n); // 0.4
    expect(roundHalfUp(15n, 10n)).toBe(2n); // 1.5
    expect(roundHalfUp(14999n, 10000n)).toBe(1n);
    expect(roundHalfUp(0n, 7n)).toBe(0n);
  });
  it("refuses negative ratios", () => {
    expect(() => roundHalfUp(-1n, 2n)).toThrow();
    expect(() => roundHalfUp(1n, 0n)).toThrow();
  });
});

describe("parseDecimal", () => {
  it("scales decimal strings without floats", () => {
    expect(parseDecimal("35.49", 2)).toBe(3549n);
    expect(parseDecimal("2400", 6)).toBe(2_400_000_000n);
    expect(parseDecimal("0.000001", 6)).toBe(1n);
  });
  it("rejects signs, exponents and extra places", () => {
    expect(() => parseDecimal("-1", 2)).toThrow();
    expect(() => parseDecimal("1e3", 2)).toThrow();
    expect(() => parseDecimal("1.234", 2)).toThrow();
  });
});

describe("application fee in basis points", () => {
  it("defaults to 1000 bps = 10%", () => {
    expect(parseBasisPoints("1000")).toBe(1000);
    expect(applicationFeeCents(2000, 1000)).toBe(200);
  });
  it("rounds half up to whole cents", () => {
    expect(applicationFeeCents(1234, 1000)).toBe(123); // 123.4
    expect(applicationFeeCents(1235, 1000)).toBe(124); // 123.5
    expect(applicationFeeCents(5, 1000)).toBe(1); // 0.5
    expect(applicationFeeCents(4, 1000)).toBe(0); // 0.4
    expect(applicationFeeCents(999, 250)).toBe(25); // 24.975
    expect(applicationFeeCents(1, 5000)).toBe(1); // 0.5
  });
  it("covers the 0% and 100% ends", () => {
    expect(applicationFeeCents(1599, 0)).toBe(0);
    expect(applicationFeeCents(1599, 10000)).toBe(1599);
  });
  it("rejects invalid configuration and amounts", () => {
    expect(() => parseBasisPoints("10001")).toThrow();
    expect(() => parseBasisPoints("-1")).toThrow();
    expect(() => parseBasisPoints("12.5")).toThrow();
    expect(() => parseBasisPoints("ten")).toThrow();
    expect(() => applicationFeeCents(10.5, 1000)).toThrow();
    expect(() => applicationFeeCents(-1, 1000)).toThrow();
    expect(() => applicationFeeCents(100, 10001)).toThrow();
  });
});

describe("idle grace credit", () => {
  const line = (exactMinor: string, priceMinorPerHour = "2400") => ({
    exactMinor,
    priceMinorPerHour,
  });
  it("waives the grace minutes at the idle rate", () => {
    // $24/h idle, 30 min idle billed (1200c), 10 min grace -> 400c waived.
    expect(
      idleGraceCreditCents({
        parkingLines: [line("1200.000000")],
        idleSeconds: 1800,
        graceSeconds: 600,
      }),
    ).toBe(400);
  });
  it("never waives more than the bill charged for idle time", () => {
    // 5 min idle billed 200c; the grace is longer than the idle time.
    expect(
      idleGraceCreditCents({
        parkingLines: [line("200.000000")],
        idleSeconds: 300,
        graceSeconds: 600,
      }),
    ).toBe(200);
  });
  it("waives the whole idle charge when the car left within the grace period", () => {
    // 30 s idle, billed as one started 60 s step (40c): all of it is waived.
    expect(
      idleGraceCreditCents({
        parkingLines: [line("40.000000")],
        idleSeconds: 30,
        graceSeconds: 600,
      }),
    ).toBe(40);
  });
  it("rounds the waiver half up once", () => {
    // 45c/h for a 40 s grace = 0.5c -> 1c
    expect(
      idleGraceCreditCents({
        parkingLines: [line("10.000000", "45")],
        idleSeconds: 1200,
        graceSeconds: 40,
      }),
    ).toBe(1);
    // 45c/h for a 39 s grace = 0.4875c -> 0c
    expect(
      idleGraceCreditCents({
        parkingLines: [line("10.000000", "45")],
        idleSeconds: 1200,
        graceSeconds: 39,
      }),
    ).toBe(0);
  });
  it("uses the lowest idle rate when several apply", () => {
    expect(
      idleGraceCreditCents({
        parkingLines: [line("600.000000", "3600"), line("400.000000", "1200")],
        idleSeconds: 1800,
        graceSeconds: 600,
      }),
    ).toBe(200);
  });
  it("is zero without idle lines, idle time or grace", () => {
    expect(
      idleGraceCreditCents({
        parkingLines: [],
        idleSeconds: 900,
        graceSeconds: 600,
      }),
    ).toBe(0);
    expect(
      idleGraceCreditCents({
        parkingLines: [line("1")],
        idleSeconds: 0,
        graceSeconds: 600,
      }),
    ).toBe(0);
    expect(
      idleGraceCreditCents({
        parkingLines: [line("1")],
        idleSeconds: 900,
        graceSeconds: 0,
      }),
    ).toBe(0);
  });
});

describe("settle: hold, capture and release in integer cents", () => {
  const base = {
    holdCents: 5000,
    graceCreditCents: 0,
    applicationFeeBps: 1000,
    chargeApplicationFee: true,
  };

  it("captures the bill and releases the rest of the hold", () => {
    const s = settle({ ...base, billTotalCents: 1600 });
    expect(s).toMatchObject({
      action: "capture",
      chargedCents: 1600,
      releasedCents: 3400,
      uncollectedCents: 0,
      applicationFeeCents: 160,
      reason: "charged",
    });
    expect(s.chargedCents + s.releasedCents).toBe(s.holdCents);
  });

  it("subtracts the idle grace credit before capturing", () => {
    const s = settle({ ...base, billTotalCents: 2475, graceCreditCents: 400 });
    expect(s).toMatchObject({
      dueCents: 2075,
      chargedCents: 2075,
      releasedCents: 2925,
      applicationFeeCents: 208,
    });
  });

  it("takes no application fee without a connected account", () => {
    expect(
      settle({ ...base, billTotalCents: 1600, chargeApplicationFee: false })
        .applicationFeeCents,
    ).toBe(0);
  });

  it("releases the whole hold for amounts under Stripe's minimum", () => {
    const s = settle({ ...base, billTotalCents: MINIMUM_CHARGE_CENTS - 1 });
    expect(s).toMatchObject({
      action: "release",
      chargedCents: 0,
      releasedCents: 5000,
      uncollectedCents: 49,
      applicationFeeCents: 0,
      reason: "below_minimum",
    });
    expect(
      settle({ ...base, billTotalCents: MINIMUM_CHARGE_CENTS }).action,
    ).toBe("capture");
  });

  it("releases when the grace credit covers the whole bill", () => {
    expect(
      settle({ ...base, billTotalCents: 300, graceCreditCents: 300 }),
    ).toMatchObject({ action: "release", reason: "zero", uncollectedCents: 0 });
  });

  it("never captures more than the hold and shows the rest as uncollected", () => {
    const s = settle({ ...base, billTotalCents: 5230 });
    expect(s).toMatchObject({
      action: "capture",
      chargedCents: 5000,
      releasedCents: 0,
      uncollectedCents: 230,
      applicationFeeCents: 500,
      reason: "capped_at_hold",
    });
  });

  it("rejects non-integer or negative money", () => {
    expect(() => settle({ ...base, billTotalCents: 10.5 })).toThrow();
    expect(() => settle({ ...base, billTotalCents: -1 })).toThrow();
    expect(() =>
      settle({ ...base, holdCents: 49.99, billTotalCents: 1 }),
    ).toThrow();
  });
});
