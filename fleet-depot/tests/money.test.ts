import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currencyExponent,
  currencyOr,
  DEFAULT_CURRENCY,
  formatMinor,
  formatPerKwh,
  groupByCurrency,
  minorToMajorString,
  mixedCurrenciesNote,
} from "@/lib/money";

describe("minor units follow the currency's exponent", () => {
  it.each([
    ["USD", 2, 1350, "13.50", "$13.50"],
    ["CAD", 2, 1350, "13.50", "CA$13.50"],
    ["EUR", 2, 1350, "13.50", "€13.50"],
    ["JPY", 0, 1350, "1350", "¥1,350"],
    ["KWD", 3, 1350, "1.350", "KWD 1.350"],
  ])("%s", (currency, exp, minor, major, shown) => {
    expect(currencyExponent(currency)).toBe(exp);
    expect(minorToMajorString(minor, currency)).toBe(major);
    expect(formatMinor(minor, currency).replace(/ /g, " ")).toBe(shown);
  });

  it("pads small and negative amounts exactly", () => {
    expect(minorToMajorString(5, "USD")).toBe("0.05");
    expect(minorToMajorString(5, "KWD")).toBe("0.005");
    expect(minorToMajorString(-250, "CAD")).toBe("-2.50");
    expect(() => minorToMajorString(1.5, "USD")).toThrow();
  });

  it("formats a per-kWh price", () => {
    expect(formatPerKwh(18, "USD")).toBe("$0.18/kWh");
    expect(formatPerKwh(22, "CAD")).toBe("CA$0.22/kWh");
  });

  it("falls back to the code for an unknown currency", () => {
    expect(formatMinor(1234, "XXBAD")).toBe("12.34 XXBAD");
  });
});

describe("currencies are never mixed", () => {
  it("groups by currency in a stable order", () => {
    const g = groupByCurrency([
      { currency: "USD", n: 1 },
      { currency: "CAD", n: 2 },
      { currency: "USD", n: 3 },
    ]);
    expect(g.map((x) => [x.currency, x.items.length])).toEqual([
      ["CAD", 1],
      ["USD", 2],
    ]);
  });
  it("notes mixed currencies only when there are several", () => {
    expect(mixedCurrenciesNote(["USD", "USD"])).toBeUndefined();
    expect(mixedCurrenciesNote(["USD", "CAD"])).toContain("CAD, USD");
  });
});

describe("the default currency", () => {
  afterEach(() => vi.restoreAllMocks());
  it("keeps a given currency without logging", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(currencyOr("CAD")).toBe("CAD");
    expect(warn).not.toHaveBeenCalled();
  });
  it("is USD and logs once at most", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(currencyOr(undefined)).toBe(DEFAULT_CURRENCY);
    expect(currencyOr(null)).toBe("USD");
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
