import { describe, expect, it } from "vitest";
import { liveReadout } from "../src/lib/live";

describe("live readout", () => {
  it("shows the SoC and power an adapter returned", () => {
    expect(liveReadout({ socPercent: 54.4, powerKw: 48.46 })).toEqual({
      socPercent: 54,
      power: "48.5 kW",
    });
    expect(liveReadout({ socPercent: 100, powerKw: 149.6 })).toEqual({
      socPercent: 100,
      power: "150 kW",
    });
  });

  it("hides what is missing, so a CPO without an adapter shows nothing extra", () => {
    expect(liveReadout({})).toEqual({});
    expect(liveReadout(null)).toEqual({});
    expect(liveReadout(undefined)).toEqual({});
    expect(liveReadout({ powerKw: 11 })).toEqual({ power: "11 kW" });
    expect(liveReadout({ socPercent: 0 })).toEqual({ socPercent: 0 });
  });

  it("hides values out of range rather than showing them wrong", () => {
    expect(liveReadout({ socPercent: 120, powerKw: -3 } as never)).toEqual({});
    expect(liveReadout({ socPercent: NaN, powerKw: 0 })).toEqual({});
    expect(liveReadout({ socPercent: "50" } as never)).toEqual({});
  });
});
