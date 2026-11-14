import { describe, expect, it } from "vitest";
import {
  tariffEnergy,
  tariffIdle,
  tariffState,
  tariffType,
  type TariffFacts,
} from "@/lib/tariff-table";

const paid: TariffFacts = {
  kind: "paid",
  currency: "USD",
  energyMinorPerKwh: 35,
  idleMinorPerMinute: 0,
  idleGraceMinutes: 0,
  periods: [],
};

describe("tariff table wording", () => {
  it("names the type", () => {
    expect(tariffType(null)).toBe("Not live yet");
    expect(tariffType({ ...paid, kind: "free" })).toBe("Free");
    expect(tariffType(paid)).toBe("Per kWh");
    expect(tariffType({ ...paid, idleMinorPerMinute: 20 })).toBe(
      "Per kWh + idle fee",
    );
    expect(tariffType({ ...paid, periods: [{ energyMinorPerKwh: 45 }] })).toBe(
      "Time of use",
    );
  });

  it("shows the stored per-kWh price, or the range with periods", () => {
    expect(tariffEnergy(paid)).toBe("$0.35");
    expect(tariffEnergy({ ...paid, kind: "free" })).toBe("Free");
    expect(
      tariffEnergy({
        ...paid,
        energyMinorPerKwh: 45,
        periods: [{ energyMinorPerKwh: 30 }],
      }),
    ).toBe("$0.30–0.45");
    expect(tariffEnergy({ ...paid, currency: "CAD" })).toBe("CA$0.35");
    expect(tariffEnergy(null)).toBe("n/a");
  });

  it("shows the idle fee and its free minutes", () => {
    expect(tariffIdle(paid)).toBe("none");
    expect(
      tariffIdle({ ...paid, idleMinorPerMinute: 20, idleGraceMinutes: 10 }),
    ).toBe("$0.20 / min after 10 min");
    expect(tariffIdle({ ...paid, idleMinorPerMinute: 20 })).toBe("$0.20 / min");
    expect(tariffIdle({ ...paid, kind: "free" })).toBe("n/a");
  });

  it("gives every state a word and a tone", () => {
    expect(tariffState({ needsFinishing: true, connectors: 3 })).toEqual({
      label: "Not confirmed",
      tone: "warn",
    });
    expect(tariffState({ needsFinishing: false, connectors: 3 }).label).toBe(
      "In use",
    );
    expect(tariffState({ needsFinishing: false, connectors: 0 }).label).toBe(
      "Unassigned",
    );
  });
});
