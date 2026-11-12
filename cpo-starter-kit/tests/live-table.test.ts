import { describe, expect, it } from "vitest";
import {
  freeConnectors,
  liveHref,
  matchesLiveFilter,
  parseLiveFilter,
} from "@/lib/live-table";

const station = (
  state: "online" | "offline" | "faulted",
  sessions: number,
  statuses: [string, boolean][] = [],
) => ({
  state,
  sessions: Array.from({ length: sessions }, () => ({})) as never,
  connectors: statuses.map(([status, busy]) => ({
    status,
    session: busy ? {} : null,
  })) as never,
});

describe("Live screen helpers", () => {
  it("reads the status filter, with anything else meaning all", () => {
    expect(parseLiveFilter("faulted")).toBe("faulted");
    expect(parseLiveFilter("nonsense")).toBe("all");
    expect(parseLiveFilter(undefined)).toBe("all");
    expect(parseLiveFilter(["offline"])).toBe("all");
  });

  it("filters chargers by status", () => {
    expect(matchesLiveFilter(station("online", 0), "all")).toBe(true);
    expect(matchesLiveFilter(station("online", 1), "charging")).toBe(true);
    expect(matchesLiveFilter(station("online", 0), "charging")).toBe(false);
    expect(matchesLiveFilter(station("faulted", 0), "faulted")).toBe(true);
    expect(matchesLiveFilter(station("offline", 0), "faulted")).toBe(false);
    expect(matchesLiveFilter(station("offline", 0), "offline")).toBe(true);
  });

  it("counts free connectors: Available with no session", () => {
    expect(
      freeConnectors(
        station("online", 0, [
          ["Available", false],
          ["Available", true],
          ["Faulted", false],
        ]),
      ),
    ).toBe(1);
  });

  it("builds Live links that keep the filter and the selected charger", () => {
    expect(liveHref("all")).toBe("/live");
    expect(liveHref("faulted")).toBe("/live?status=faulted");
    expect(liveHref("all", 7)).toBe("/live?charger=7");
    expect(liveHref("offline", 7)).toBe("/live?status=offline&charger=7");
  });
});
