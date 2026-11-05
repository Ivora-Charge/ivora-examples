import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currencyExponent,
  currencyOr,
  DEFAULT_CURRENCY,
  formatMinor,
  formatMinorDecimal,
  minorToMajorString,
  mixedCurrenciesNote,
  parseMajor,
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
    expect(parseMajor(major, currency)).toBe(minor);
    expect(formatMinor(minor, currency).replace(/ /g, " ")).toBe(shown);
  });

  it("pads small and negative amounts exactly", () => {
    expect(minorToMajorString(5, "USD")).toBe("0.05");
    expect(minorToMajorString(5, "KWD")).toBe("0.005");
    expect(minorToMajorString(5, "JPY")).toBe("5");
    expect(minorToMajorString(-250, "CAD")).toBe("-2.50");
    expect(() => minorToMajorString(1.5, "USD")).toThrow();
  });

  it("rejects more decimals than the currency has", () => {
    expect(parseMajor("0.355", "USD")).toBeNull();
    expect(parseMajor("0.355", "KWD")).toBe(355);
    expect(parseMajor("12.5", "JPY")).toBeNull();
    expect(parseMajor("-1", "USD")).toBeNull();
  });

  it("formats the digits of the currency, not always two", () => {
    expect(formatMinor(0, "JPY")).toBe("¥0");
    expect(formatMinor(1, "KWD")).toContain("0.001");
    expect(formatMinorDecimal("35", "CAD")).toBe("CA$0.35");
    expect(formatMinorDecimal("0.6667", "USD")).toBe("$0.006667");
  });

  it("uses the locale it is given", () => {
    expect(formatMinor(1350, "CAD", "en-CA")).toBe("$13.50");
    expect(formatMinor(1350, "CAD", "en-US")).toBe("CA$13.50");
    expect(formatMinor(1350, "CAD", "fr-CA").replace(/ /g, " ")).toBe(
      "13,50 $",
    );
  });

  it("falls back to the code for an unknown currency", () => {
    expect(formatMinor(100, "XXZ")).toContain("XXZ");
  });
});

describe("default currency", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes a currency through and defaults to USD, logging once", async () => {
    vi.resetModules();
    const { currencyOr: fresh } = await import("@/lib/money");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(fresh("CAD")).toBe("CAD");
    expect(warn).not.toHaveBeenCalled();
    expect(fresh(null)).toBe(DEFAULT_CURRENCY);
    expect(fresh(undefined)).toBe("USD");
    expect(fresh("")).toBe("USD");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(currencyOr("EUR")).toBe("EUR");
  });
});

describe("mixed currencies", () => {
  it("notes more than one currency and nothing otherwise", () => {
    expect(mixedCurrenciesNote([])).toBeUndefined();
    expect(mixedCurrenciesNote(["USD", "USD"])).toBeUndefined();
    expect(mixedCurrenciesNote(["USD", "CAD"])).toContain("CAD, USD");
  });
});
