import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getIvora,
  idempotencyKey,
  resetIvoraForTests,
} from "@/lib/server/ivora";
import { createLiveClient } from "@/lib/server/ivora/live";
import { isDemo } from "@/lib/server/env";
import { loadOverview } from "@/lib/server/overview";

const VARS = ["IVORA_API_KEY", "IVORA_TENANT_ID", "DEMO_MODE"];

describe("demo mode", () => {
  const saved = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const k of VARS) delete process.env[k];
    resetIvoraForTests();
    // Demo mode must never reach the network: any fetch fails the test.
    fetchSpy = vi.fn(() => {
      throw new Error("demo mode must not call fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  it("is on when credentials are missing or empty, and can be forced", () => {
    expect(isDemo()).toBe(true);
    process.env.IVORA_API_KEY = "test-key";
    expect(isDemo()).toBe(true);
    process.env.IVORA_TENANT_ID = "  ";
    expect(isDemo()).toBe(true);
    process.env.IVORA_TENANT_ID = "42";
    expect(isDemo()).toBe(false);
    process.env.DEMO_MODE = "true";
    expect(isDemo()).toBe(true);
  });

  it("runs every client method on labelled sample data without any network call", async () => {
    const ivora = getIvora();
    expect(ivora.mode).toBe("demo");

    const stations = await ivora.listStations();
    expect(stations.length).toBeGreaterThan(0);
    expect(stations.every((s) => s.name.startsWith("DEMO-"))).toBe(true);
    expect((await ivora.getStation(stations[0].id)).id).toBe(stations[0].id);
    await expect(ivora.getStation(1)).rejects.toMatchObject({
      code: "station_not_found",
    });

    const locations = await ivora.listLocations();
    expect(locations.every((l) => l.name.startsWith("Sample"))).toBe(true);
    const key = idempotencyKey("location", "site-1", "create");
    const input = { name: "Depot", external_reference: "cpo-site-1" };
    const a = await ivora.createLocation(input, key);
    expect(a.name).toBe("Sample Site: Depot");
    // Same key, same record: a retry does not create a second location.
    expect((await ivora.createLocation(input, key)).id).toBe(a.id);
    expect(await ivora.listLocations()).toHaveLength(locations.length + 1);

    expect((await ivora.listTransactions()).length).toBeGreaterThan(0);

    const r = await loadOverview();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.overview.mode).toBe("demo");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves demo even with credentials when DEMO_MODE is forced", async () => {
    process.env.IVORA_API_KEY = "test-key";
    process.env.IVORA_TENANT_ID = "42";
    process.env.DEMO_MODE = "1";
    expect(getIvora().mode).toBe("demo");
    await getIvora().listStations();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a live client refuses to send while demo mode is on", async () => {
    const liveFetch = vi.fn(async () => Response.json({ data: [] }));
    const live = createLiveClient({
      baseUrl: "https://api.example.test",
      apiKey: "test-key",
      tenantId: "42",
      fetch: liveFetch,
    });
    await expect(live.listStations()).rejects.toThrow(/Demo mode/);
    await expect(
      live.createLocation(
        { name: "X", external_reference: "cpo-site-x" },
        idempotencyKey("location", "x", "create"),
      ),
    ).rejects.toThrow(/Demo mode/);
    expect(liveFetch).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
