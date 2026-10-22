import { describe, expect, it } from "vitest";
import { formatKwh, whToKwh } from "@/lib/units";
import { MODULES, visibleModules } from "@/lib/modules";

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
      "Cards",
      "Team",
      "Settings",
    ]);
    expect(new Set(MODULES.map((m) => m.href)).size).toBe(MODULES.length);
  });

  it("shows the optional Cards module only when FLEET_MODULE is on", () => {
    const off = visibleModules({ fleet: false }).map((m) => m.slug);
    expect(off).not.toContain("cards");
    expect(off).toHaveLength(MODULES.length - 1);
    expect(visibleModules({ fleet: true }).map((m) => m.slug)).toContain(
      "cards",
    );
  });
});
