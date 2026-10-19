import { describe, expect, it } from "vitest";
import { getDepot, boardState, report } from "@/lib/depot";
import { advanceDemo } from "@/lib/demo";

describe("demo end to end", () => {
  it("plugs vehicles in during the evening, respects the cap, and ends sessions in the morning", async () => {
    process.env.DEMO_MODE = "true";
    const d = await getDepot();
    await advanceDemo(d, 6 * 60); // to ~22:30
    let s = await boardState(d);
    expect(s.rows.filter((r) => r.session)).toHaveLength(6);
    expect(s.totalKw).toBeLessThanOrEqual(s.settings.siteCapKw + 1e-6);
    expect(s.rows.every((r) => r.session?.profile?.status === "accepted")).toBe(
      true,
    );
    await advanceDemo(d, 12 * 60); // past every departure
    s = await boardState(d);
    expect(s.rows.filter((r) => r.session)).toHaveLength(0);
    const today = d.clock!.toISOString().slice(0, 7);
    expect((await report(d, today, "vehicle")).length).toBe(6);
  });
});
