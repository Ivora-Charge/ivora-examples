import { describe, expect, it, vi } from "vitest";
import { IvoraError } from "@/lib/server/ivora";
import { loadTrend } from "@/lib/server/overview-trend";
import type { ReportsDeps } from "@/lib/server/reports";
import type { Staff } from "@/lib/server/team/types";

const staff: Staff = {
  userId: "u1",
  email: "demo-owner@example.com",
  role: "owner",
  operatorId: "op1",
  operatorName: "Sample Operator",
  demo: true,
};

function deps(opts: {
  zone: string | null;
  fail?: boolean;
  siteZones?: (string | null)[];
  sitesFail?: boolean;
}) {
  const getStats = vi.fn(async () => {
    if (opts.fail) throw new IvoraError(500, "server_error", "boom");
    return { series: [] };
  });
  const listAllLocations = vi.fn(async () => {
    if (opts.sitesFail) throw new IvoraError(500, "server_error", "boom");
    return {
      data: (opts.siteZones ?? []).map((time_zone, i) => ({
        id: i + 1,
        time_zone,
      })),
      truncated: false,
    };
  });
  const d = {
    ivora: { getStats, listAllLocations, mode: "demo" },
    company: {
      load: async () => ({ timeZone: opts.zone }),
    },
    now: () => Date.parse("2026-11-14T12:00:00Z"),
  } as unknown as ReportsDeps;
  return { d, getStats };
}

describe("overview 30-day trend", () => {
  it("asks for the Reports page's 30-day preset by day, in the company zone", async () => {
    const { d, getStats } = deps({ zone: "Europe/Berlin" });
    const r = await loadTrend(d, staff);
    expect(r.zone).toBe("Europe/Berlin");
    expect(r.result.ok).toBe(true);
    expect(getStats).toHaveBeenCalledTimes(1);
    const q = (getStats.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(q.bucket).toBe("day");
    expect(q.time_zone).toBe("Europe/Berlin");
    const days =
      (Date.parse(q.to as string) - Date.parse(q.from as string)) / 864e5;
    expect(Math.round(days)).toBe(30);
  });

  it("falls back like Reports: the sites' one shared zone, else UTC", async () => {
    const shared = deps({
      zone: null,
      siteZones: ["America/Chicago", "America/Chicago"],
    });
    expect((await loadTrend(shared.d, staff)).zone).toBe("America/Chicago");
    const mixed = deps({
      zone: null,
      siteZones: ["America/Chicago", "Europe/Berlin"],
    });
    expect((await loadTrend(mixed.d, staff)).zone).toBe("UTC");
    expect((await loadTrend(deps({ zone: null }).d, staff)).zone).toBe("UTC");
    // The company's own zone wins over the sites'.
    const own = deps({ zone: "Europe/Berlin", siteZones: ["America/Chicago"] });
    expect((await loadTrend(own.d, staff)).zone).toBe("Europe/Berlin");
  });

  it("still draws the chart, in UTC, when the sites can't be read", async () => {
    const { d, getStats } = deps({ zone: null, sitesFail: true });
    const r = await loadTrend(d, staff);
    expect(r.zone).toBe("UTC");
    expect(getStats).toHaveBeenCalledTimes(1);
  });

  it("reports a failed read instead of throwing", async () => {
    const { d } = deps({ zone: null, fail: true });
    const r = await loadTrend(d, staff);
    expect(r.result.ok).toBe(false);
  });
});
