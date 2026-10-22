import { describe, expect, it } from "vitest";
import { liveReadout } from "../src/lib/live";

const NOW = Date.parse("2026-10-22T08:30:00Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const fresh = ago(10);

describe("live readout", () => {
  it("shows the SoC and power an adapter returned", () => {
    expect(
      liveReadout(
        {
          socPercent: 54.4,
          socMeasuredAt: fresh,
          powerKw: 48.46,
          powerMeasuredAt: fresh,
        },
        NOW,
      ),
    ).toEqual({ socPercent: 54, power: "48.5 kW" });
    expect(
      liveReadout(
        {
          socPercent: 100,
          socMeasuredAt: fresh,
          powerKw: 149.6,
          powerMeasuredAt: fresh,
        },
        NOW,
      ),
    ).toEqual({ socPercent: 100, power: "150 kW" });
  });

  it("hides what is missing, so a CPO without an adapter shows nothing extra", () => {
    expect(liveReadout({}, NOW)).toEqual({});
    expect(liveReadout(null, NOW)).toEqual({});
    expect(liveReadout(undefined, NOW)).toEqual({});
    expect(liveReadout({ powerKw: 11, powerMeasuredAt: fresh }, NOW)).toEqual({
      power: "11 kW",
    });
    expect(liveReadout({ socPercent: 0, socMeasuredAt: fresh }, NOW)).toEqual({
      socPercent: 0,
    });
  });

  it("hides values out of range rather than showing them wrong", () => {
    const at = { socMeasuredAt: fresh, powerMeasuredAt: fresh };
    expect(
      liveReadout({ socPercent: 120, powerKw: -3, ...at } as never, NOW),
    ).toEqual({});
    expect(liveReadout({ socPercent: NaN, powerKw: 0, ...at }, NOW)).toEqual(
      {},
    );
    expect(liveReadout({ socPercent: "50", ...at } as never, NOW)).toEqual({});
  });

  it("hides stale readings: a suspended or offline charger shows no power", () => {
    // No time: nothing to judge it by.
    expect(liveReadout({ socPercent: 50, powerKw: 11 }, NOW)).toEqual({});
    // Power 4 minutes old is gone; the SoC says how old it is.
    expect(
      liveReadout(
        {
          socPercent: 61,
          socMeasuredAt: ago(6 * 60 + 5),
          powerKw: 48.5,
          powerMeasuredAt: ago(4 * 60),
        },
        NOW,
      ),
    ).toEqual({ socPercent: 61, socAge: "last seen 6 min ago" });
    // A fresh SoC never keeps an old power on screen.
    expect(
      liveReadout(
        {
          socPercent: 61,
          socMeasuredAt: fresh,
          powerKw: 48.5,
          powerMeasuredAt: ago(40 * 60),
        },
        NOW,
      ),
    ).toEqual({ socPercent: 61 });
    // Both 40 minutes old: nothing at all.
    expect(
      liveReadout(
        {
          socPercent: 61,
          socMeasuredAt: ago(40 * 60),
          powerKw: 48.5,
          powerMeasuredAt: ago(40 * 60),
        },
        NOW,
      ),
    ).toEqual({});
    // Far in the future: a wrong clock somewhere, not shown.
    expect(
      liveReadout({ socPercent: 61, socMeasuredAt: ago(-10 * 60) }, NOW),
    ).toEqual({});
  });
});
