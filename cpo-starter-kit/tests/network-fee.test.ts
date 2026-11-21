import { describe, expect, it } from "vitest";
import {
  describeTerms,
  divideHalfUp,
  feeRefunded,
  feeRefundStep,
  formatPercent,
  MINIMUM_CHARGE_MINOR,
  networkFee,
  parseFeeAmount,
  parsePercent,
  validTerms,
  type FeeTerms,
} from "@/lib/network-fee";
import { formatMinor } from "@/lib/money";

// The network fee: integer minor units, one rounding (half up, at the end), never more
// than what was captured. Table tests in USD and CAD.

const percent = (bps: number, currency = "USD"): FeeTerms => ({
  mode: "percent",
  percentBps: bps,
  perKwhMinor: 0,
  monthlyChargerFeeMinor: 0,
  currency,
});
const perKwh = (minor: number, currency = "USD"): FeeTerms => ({
  mode: "per_kwh",
  percentBps: 0,
  perKwhMinor: minor,
  monthlyChargerFeeMinor: 0,
  currency,
});

describe("divideHalfUp", () => {
  it.each([
    [0, 7, 0],
    [5, 10, 1],
    [4, 10, 0],
    [15, 10, 2],
    [14, 10, 1],
    [2499, 1000, 2],
    [2500, 1000, 3],
    [99, 100, 1],
  ])("%i / %i = %i", (n, d, q) => expect(divideHalfUp(n, d)).toBe(q));

  it("refuses negatives, zero divisors and fractions", () => {
    expect(() => divideHalfUp(-1, 2)).toThrow();
    expect(() => divideHalfUp(1, 0)).toThrow();
    expect(() => divideHalfUp(1.5, 2)).toThrow();
  });
});

describe("network fee", () => {
  type Row = [
    name: string,
    terms: FeeTerms,
    capturedMinor: number,
    energyWh: number | null,
    currency: string,
    fee: number,
    hostShare: number,
  ];
  const rows: Row[] = [
    // Percent of the captured amount.
    ["10% of $13.50", percent(1000), 1350, 30_000, "USD", 135, 1215],
    ["10% of CA$13.50", percent(1000, "CAD"), 1350, 30_000, "CAD", 135, 1215],
    ["7.5% of $13.47 (101.025 → 101)", percent(750), 1347, 1, "USD", 101, 1246],
    [
      "7.5% of CA$13.46 (100.95 → 101)",
      percent(750, "CAD"),
      1346,
      1,
      "CAD",
      101,
      1245,
    ],
    ["2.5% of $0.98 (2.45 → 2)", percent(250), 98, null, "USD", 2, 96],
    [
      "percent applies to any currency",
      percent(1000, "USD"),
      2000,
      null,
      "CAD",
      200,
      1800,
    ],
    ["100% leaves the host nothing", percent(10_000), 2500, 1, "USD", 2500, 0],
    // A flat amount per kWh, on the energy in Wh.
    ["$0.05/kWh × 30 kWh", perKwh(5), 1350, 30_000, "USD", 150, 1200],
    ["CA$0.05/kWh × 30 kWh", perKwh(5, "CAD"), 1350, 30_000, "CAD", 150, 1200],
    [
      "$0.05/kWh × 12.345 kWh (61.725 → 62)",
      perKwh(5),
      900,
      12_345,
      "USD",
      62,
      838,
    ],
    [
      "CA$0.04/kWh × 0.1 kWh (0.4 → 0)",
      perKwh(4, "CAD"),
      75,
      100,
      "CAD",
      0,
      75,
    ],
    [
      "CA$0.03/kWh × 0.5 kWh (1.5 → 2)",
      perKwh(3, "CAD"),
      60,
      500,
      "CAD",
      2,
      58,
    ],
    // Zero fee.
    ["0% fee", percent(0), 1350, 30_000, "USD", 0, 1350],
    ["CA$0/kWh fee", perKwh(0, "CAD"), 1350, null, "CAD", 0, 1350],
    // The minimum charge: a bill under it captures nothing, so there is no fee; at
    // the minimum the fee is on 50 cents; a fee above the amount is cut to it.
    [
      "USD under the minimum: nothing captured",
      percent(1000),
      0,
      400,
      "USD",
      0,
      0,
    ],
    [
      "CAD under the minimum: nothing captured",
      perKwh(5, "CAD"),
      0,
      400,
      "CAD",
      0,
      0,
    ],
    [
      "10% of the USD minimum",
      percent(1000),
      MINIMUM_CHARGE_MINOR.USD,
      1_000,
      "USD",
      5,
      45,
    ],
    [
      "10% of the CAD minimum",
      percent(1000, "CAD"),
      MINIMUM_CHARGE_MINOR.CAD,
      1_000,
      "CAD",
      5,
      45,
    ],
    [
      "per kWh above a minimum charge is cut to it (USD)",
      perKwh(100),
      50,
      2_000,
      "USD",
      50,
      0,
    ],
    [
      "per kWh above a minimum charge is cut to it (CAD)",
      perKwh(100, "CAD"),
      50,
      2_000,
      "CAD",
      50,
      0,
    ],
  ];
  it.each(rows)("%s", (_n, terms, captured, energyWh, currency, fee, share) => {
    const r = networkFee(terms, {
      capturedMinor: captured,
      energyWh,
      currency,
    });
    expect(r).toEqual({ ok: true, feeMinor: fee, hostShareMinor: share });
    // Every result is whole minor units and adds up to what was captured.
    if (r.ok) expect(r.feeMinor + r.hostShareMinor).toBe(captured);
  });

  it("a per-kWh fee waits for the session's energy", () => {
    expect(
      networkFee(perKwh(5), {
        capturedMinor: 1000,
        energyWh: null,
        currency: "USD",
      }),
    ).toEqual({ ok: false, reason: "energy" });
  });

  it("a per-kWh fee in another currency is never converted", () => {
    expect(
      networkFee(perKwh(5, "USD"), {
        capturedMinor: 1000,
        energyWh: 1000,
        currency: "CAD",
      }),
    ).toEqual({ ok: false, reason: "currency" });
  });

  it("refuses invalid terms and amounts", () => {
    expect(() =>
      networkFee(percent(10_001), {
        capturedMinor: 1,
        energyWh: 1,
        currency: "USD",
      }),
    ).toThrow();
    expect(() =>
      networkFee(percent(100), {
        capturedMinor: -1,
        energyWh: 1,
        currency: "USD",
      }),
    ).toThrow();
    expect(() =>
      networkFee(percent(100), {
        capturedMinor: 1.5,
        energyWh: 1,
        currency: "USD",
      }),
    ).toThrow();
    expect(validTerms({ ...percent(100), currency: "usd" })).toBe(false);
  });
});

describe("refunds return the fee in proportion", () => {
  it.each([
    // fee, captured, refunded, fee returned
    [135, 1350, 1350, 135],
    [135, 1350, 675, 68], // 67.5 → 68
    [135, 1350, 0, 0],
    [101, 1347, 500, 37], // 37.49 → 37
    [5, 50, 25, 3], // 2.5 → 3
    [135, 1350, 5000, 135], // never more than the fee
  ])("fee %i of %i, refund %i → %i", (fee, captured, refunded, back) =>
    expect(feeRefunded(fee, captured, refunded)).toBe(back),
  );

  it("several partial refunds never return more than the fee", () => {
    const fee = 101;
    const captured = 1347;
    let before = 0;
    let back = 0;
    for (const step of [333, 333, 333, 348]) {
      back += feeRefundStep(fee, captured, before, step);
      before += step;
    }
    expect(back).toBe(fee);
    expect(back).toBe(feeRefunded(fee, captured, captured));
  });
});

describe("fee form values", () => {
  it("parses percentages to basis points", () => {
    expect(parsePercent("10")).toBe(1000);
    expect(parsePercent("7.5")).toBe(750);
    expect(parsePercent("7.25%")).toBe(725);
    expect(parsePercent("100")).toBe(10_000);
    expect(parsePercent("100.01")).toBeNull();
    expect(parsePercent("7.255")).toBeNull();
    expect(parsePercent("-1")).toBeNull();
    expect(parsePercent("1e2")).toBeNull();
    expect(formatPercent(725)).toBe("7.25%");
    expect(formatPercent(1000)).toBe("10%");
  });

  it("parses amounts in the currency's minor units, no floating point", () => {
    expect(parseFeeAmount("0.05", "USD", 10_000)).toBe(5);
    expect(parseFeeAmount("0.05", "CAD", 10_000)).toBe(5);
    expect(parseFeeAmount("", "USD", 10_000)).toBe(0);
    expect(parseFeeAmount("0.005", "USD", 10_000)).toBeNull();
    expect(parseFeeAmount("100.01", "USD", 10_000)).toBeNull();
  });

  it("describes the terms in words", () => {
    expect(
      describeTerms(
        { ...perKwh(5, "CAD"), monthlyChargerFeeMinor: 1500 },
        formatMinor,
      ),
    ).toBe(
      "CA$0.05 per kWh; CA$15.00 a month per charger (not collected by the kit)",
    );
    expect(describeTerms(percent(750), formatMinor)).toBe(
      "7.5% of each session's amount",
    );
  });
});
