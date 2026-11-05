import { describe, expect, it } from "vitest";
import { formatMinor, minorDigits, toMinor } from "@/lib/payments/money";
import {
  formatMinorAmount,
  formatMoney,
  fractionDigits,
} from "@/lib/locations/pricing";
import { minorToDecimal } from "@/lib/admin/reconciliation";

const nbsp = (s: string) => s.replace(/ /g, " ");

describe("minor units follow the currency's exponent", () => {
  it.each([
    ["USD", 2, 1350, "13.50", "$13.50"],
    ["CAD", 2, 1350, "13.50", "CA$13.50"],
    ["EUR", 2, 1350, "13.50", "€13.50"],
    ["JPY", 0, 1350, "1350", "¥1,350"],
    ["KWD", 3, 1350, "1.350", "KWD 1.350"],
  ])("%s", (currency, digits, minor, major, shown) => {
    expect(fractionDigits(currency)).toBe(digits);
    expect(minorDigits(currency)).toBe(digits);
    expect(minorToDecimal(minor, currency)).toBe(major);
    expect(nbsp(formatMinorAmount(minor, currency))).toBe(shown);
    expect(nbsp(formatMinor(minor, currency))).toBe(shown);
    // An OCPI decimal round-trips to the same minor units.
    expect(toMinor(Number(major), currency)).toBe(minor);
  });

  it("pads small and negative amounts exactly", () => {
    expect(formatMinorAmount(5, "CAD")).toBe("CA$0.05");
    expect(nbsp(formatMinorAmount(5, "KWD"))).toBe("KWD 0.005");
    expect(formatMinorAmount(-250, "CAD")).toBe("-CA$2.50");
  });

  it("formats an OCPI price (a decimal of the major unit) in its currency", () => {
    expect(formatMoney(1.5, "CAD")).toBe("CA$1.50");
    expect(nbsp(formatMoney(1.5, "KWD"))).toBe("KWD 1.500");
  });

  it("falls back to the code for an unknown currency", () => {
    expect(formatMinorAmount(1234, "XXBAD")).toBe("12.34 XXBAD");
  });
});
