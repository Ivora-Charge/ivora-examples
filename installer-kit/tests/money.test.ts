import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currencyExponent,
  currencyOr,
  DEFAULT_CURRENCY,
  formatMinor,
  isCurrencyCode,
  minorToMajorString,
} from "@/lib/money";
import { quoteMinor } from "@/lib/tariff";

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

  it("quotes a 20 kWh charge in the currency's minor units", () => {
    expect(formatMinor(quoteMinor(20_000, 40), "CAD")).toBe("CA$8.00");
    expect(formatMinor(quoteMinor(20_000, 40), "JPY")).toBe("¥800");
    expect(
      formatMinor(quoteMinor(20_000, 40), "KWD").replace(/\u00a0/g, " "),
    ).toBe("KWD 0.800");
  });

  it("accepts only real ISO 4217 codes", () => {
    expect(isCurrencyCode("CAD")).toBe(true);
    expect(isCurrencyCode("cad")).toBe(false);
    expect(isCurrencyCode("ZZZ1")).toBe(false);
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
