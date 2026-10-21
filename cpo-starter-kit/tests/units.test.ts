import { describe, expect, it } from "vitest";
import { formatKwh, whToKwh } from "@/lib/units";
import { MODULES } from "@/lib/modules";

describe("units", () => {
  it("converts Wh to kWh in one place", () => {
    expect(whToKwh(0)).toBe(0);
    expect(whToKwh(31_200)).toBe(31.2);
    expect(whToKwh(1)).toBe(0.001);
  });

  it("formats kWh for display", () => {
    expect(formatKwh(38.65)).toBe("38.7 kWh");
    expect(formatKwh(1234)).toBe("1,234 kWh");
  });
});

describe("modules", () => {
  it("lists every section with a unique path", () => {
    expect(MODULES.map((m) => m.label)).toEqual([
      "Overview",
      "Onboarding",
      "Chargers",
      "Live",
      "Pricing",
      "Reports",
      "Team",
      "Settings",
    ]);
    expect(new Set(MODULES.map((m) => m.href)).size).toBe(MODULES.length);
  });
});
