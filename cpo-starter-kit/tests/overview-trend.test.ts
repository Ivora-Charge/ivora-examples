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

function deps(opts: { zone: string | null; fail?: boolean }) {
  const getStats = vi.fn(async () => {
    if (opts.fail) throw new IvoraError(500, "server_error", "boom");
    return { series: [] };
  });
  const d = {
    ivora: { getStats, mode: "demo" },
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

  it("falls back to UTC until the company has a time zone", async () => {
    const { d } = deps({ zone: null });
    expect((await loadTrend(d, staff)).zone).toBe("UTC");
  });

  it("reports a failed read instead of throwing", async () => {
    const { d } = deps({ zone: null, fail: true });
    const r = await loadTrend(d, staff);
    expect(r.result.ok).toBe(false);
  });
});
