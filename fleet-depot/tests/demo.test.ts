import { afterAll, describe, expect, it, vi } from "vitest";
import { getDepot, boardState, report } from "@/lib/depot";
import { advanceDemo } from "@/lib/demo";
import { blockDriver, importDrivers } from "@/lib/drivers";

describe("demo end to end", () => {
  const fetchSpy = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetchSpy);
  afterAll(() => vi.unstubAllGlobals());

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
    // Card values reach the browser masked.
    expect(s.drivers.every((x) => !x.card || /^\*{4}.{4}$/.test(x.card))).toBe(
      true,
    );
    await advanceDemo(d, 12 * 60); // past every departure
    s = await boardState(d);
    expect(s.rows.filter((r) => r.session)).toHaveLength(0);
    const today = d.clock!.toISOString().slice(0, 7);
    expect((await report(d, today, "vehicle")).length).toBe(6);
  });

  it("imports and blocks cards locally without calling any service", async () => {
    const d = await getDepot();
    const r = await importDrivers(
      d,
      "idTag,driverName\nDEMO9001,Sample Driver\nbad tag!,X",
    );
    expect(r.imported).toBe(1);
    expect(r.errors).toHaveLength(1);
    const drv = (await d.store.list("drivers")).find(
      (x) => x.idTag === "DEMO9001",
    )!;
    expect((await blockDriver(d, drv.id)).cardBlocked).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
