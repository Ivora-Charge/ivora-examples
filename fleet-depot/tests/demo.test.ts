import { afterAll, describe, expect, it, vi } from "vitest";
import { getDepot, boardState, report } from "@/lib/depot";
import {
  AT_RISK_VEHICLE,
  CHARGERS,
  advanceDemo,
  demoState,
  peaks,
  resetDemo,
} from "@/lib/demo";
import { blockDriver, importDrivers } from "@/lib/drivers";
import { statusOf } from "@/lib/timeline";

describe("demo end to end", () => {
  const fetchSpy = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetchSpy);
  afterAll(() => vi.unstubAllGlobals());

  it("seeds a 12-vehicle depot with L2 and DC chargers and a 150 kW cap", async () => {
    process.env.DEMO_MODE = "true";
    process.env.SITE_CAP_KW = "60";
    const d = await getDepot();
    expect(d.settings.siteCapKw).toBe(150);
    const s = await boardState(d);
    expect(s.rows).toHaveLength(12);
    expect(CHARGERS.length).toBeGreaterThanOrEqual(6);
    expect(CHARGERS.length).toBeLessThanOrEqual(8);
    expect(CHARGERS.filter((c) => c.type === "DC fast").length).toBeGreaterThan(
      0,
    );
    const heavy = s.rows.filter((r) => r.vehicle.batteryKwh >= 200);
    expect(heavy).toHaveLength(2);
    for (const r of s.rows) {
      const dep = new Date(r.vehicle.departure!);
      const h = dep.getHours() + dep.getMinutes() / 60;
      expect(h).toBeGreaterThanOrEqual(5.5);
      expect(h).toBeLessThanOrEqual(8);
    }
    // Cards are made-up values, masked in the browser.
    expect(s.drivers.every((x) => !x.card || /^\*{4}.{4}$/.test(x.card))).toBe(
      true,
    );
  });

  it("plays the night: the at-risk van is flagged, prioritised, and every vehicle leaves ready", async () => {
    const d = await getDepot();
    const st = demoState(d)!;
    let flagged = false;
    let others = new Set<string>();
    let capOk = true;
    for (let i = 0; i < 31 * 2; i++) {
      await advanceDemo(d, 30);
      const s = await boardState(d);
      capOk &&= s.totalKw <= s.settings.siteCapKw + 1e-6;
      for (const r of s.rows) {
        if (statusOf(r) !== "late") continue;
        if (r.vehicle.id === AT_RISK_VEHICLE) flagged = true;
        else others.add(r.vehicle.name);
      }
    }
    expect(capOk).toBe(true);
    expect(flagged).toBe(true);
    expect([...others]).toEqual([]);
    const s = await boardState(d);
    expect(s.rows.filter((r) => r.session)).toHaveLength(0);
    expect(Object.keys(st.outcomes)).toHaveLength(12);
    expect(Object.values(st.outcomes).every((o) => o.ready)).toBe(true);
    expect(
      s.rows.every(
        (r) =>
          statusOf({ ...r, departed: st.outcomes[r.vehicle.id] }) === "ready",
      ),
    ).toBe(true);
    // The managed peak stays under the cap; the comparison is far above it.
    const p = peaks(st);
    expect(p.peakKw).toBeLessThanOrEqual(150 + 1e-6);
    expect(p.peakKw).toBeGreaterThan(120);
    expect(p.ghostPeakKw).toBeGreaterThan(200);
    // The at-risk van was flagged earlier in the night and still left ready.
    expect(st.outcomes[AT_RISK_VEHICLE].ready).toBe(true);
  });

  it("has a month of history for every vehicle and driver, and reset starts the night again", async () => {
    const d = await getDepot();
    const month = d.clock!.toISOString().slice(0, 7);
    const prev = new Date(d.clock!);
    prev.setUTCMonth(prev.getUTCMonth() - 1, 1);
    const rows = [
      ...(await report(d, month, "vehicle")),
      ...(await report(d, prev.toISOString().slice(0, 7), "vehicle")),
    ];
    expect(new Set(rows.map((r) => r.key)).size).toBe(12);
    expect(
      (await report(d, prev.toISOString().slice(0, 7), "driver")).length,
    ).toBeGreaterThanOrEqual(8);
    await resetDemo(d);
    const s = await boardState(d);
    expect(new Date(s.now).getHours()).toBe(16);
    expect(s.rows.every((r) => !r.session)).toBe(true);
    expect(demoState(d)!.samples).toHaveLength(0);
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
