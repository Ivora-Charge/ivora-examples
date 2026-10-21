import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as detailRoute from "@/app/api/v1/locations/[id]/route";
import * as previewRoute from "@/app/api/v1/locations/[id]/price-preview/route";
import * as searchRoute from "@/app/api/v1/locations/route";
import { sampleLocations, sampleTariffs } from "@/lib/mock-cpo/sample-data";
import {
  boundingBox,
  distanceM,
  locationAppId,
  parseLocationAppId,
  parseSearchQuery,
  searchLocations,
  SearchQueryError,
  type SearchQuery,
} from "@/lib/locations/search";
import { MemoryLocationStore } from "@/lib/locations/store";

const ONE = "peer-one";
const TWO = "peer-two";
const CENTER = { lat: 52.09074, lng: 5.12142 };

let store: MemoryLocationStore;
beforeEach(async () => {
  store = new MemoryLocationStore();
  const at = "2026-10-21T10:00:00Z";
  const p1 = { countryCode: "ZZ", partyId: "MCK" };
  const p2 = { countryCode: "YY", partyId: "TWO" };
  await store.saveLocations(ONE, sampleLocations(p1), at);
  await store.saveTariffs(ONE, sampleTariffs(p1), at);
  // Same IDs, far away.
  await store.saveLocations(
    TWO,
    sampleLocations(p2, 6, { center: { lat: 48.85, lng: 2.35 } }),
    at,
  );
  await store.saveTariffs(TWO, sampleTariffs(p2), at);
});

const q = (params: Record<string, string>) =>
  parseSearchQuery(new URLSearchParams(params));
const names = async (query: SearchQuery, peers = [ONE, TWO]) =>
  (await searchLocations(store, peers, query)).items.map((i) => i.name);
const near = (extra: Record<string, string> = {}) =>
  q({ lat: String(CENTER.lat), lng: String(CENTER.lng), ...extra });

describe("search query", () => {
  it("reads every parameter, with defaults", () => {
    expect(
      q({
        lat: "52.1",
        lng: "5.1",
        radius_m: "2000",
        q: " market ",
        status: "available,charging",
        min_power_kw: "50",
        connector: "IEC_62196_T2_COMBO",
        facility: "WIFI",
        facility_ignored: "x",
        parking: "DISABLED",
        exclude_parking: "CUSTOMERS",
        price: "FREE",
        limit: "5",
        offset: "10",
      }),
    ).toEqual({
      near: { lat: 52.1, lng: 5.1, radiusM: 2000 },
      text: "market",
      status: ["AVAILABLE", "CHARGING"],
      minPowerKw: 50,
      connectors: ["IEC_62196_T2_COMBO"],
      facilities: ["WIFI"],
      parking: ["DISABLED"],
      excludeParking: ["CUSTOMERS"],
      price: "free",
      limit: 5,
      offset: 10,
    });
    expect(q({})).toEqual({ limit: 20, offset: 0 });
    expect(q({ lat: "1", lng: "2" }).near?.radiusM).toBe(5000);
  });

  it("refuses bad values with a message", () => {
    for (const [params, message] of [
      [{ lat: "52" }, "lat and lng go together"],
      [{ radius_m: "10" }, "radius_m needs lat and lng"],
      [
        { lat: "1", lng: "2", radius_m: "100000" },
        "radius_m must be a number from 1 to 50000",
      ],
      [{ lat: "abc", lng: "1" }, "lat must be a number from -90 to 90"],
      [{ status: "AVAILABLE,EXPLODED" }, "status has an unknown value"],
      [{ price: "cheap" }, "price must be free or paid"],
      [{ limit: "1000" }, "limit must be a number from 1 to 100"],
      [{ limit: "2.5" }, "limit and offset must be whole numbers"],
      [{ q: "x".repeat(101) }, "q must be at most 100 characters"],
    ] as const)
      expect(() => q(params)).toThrow(new SearchQueryError(message));
  });
});

describe("location search", () => {
  it("finds locations near a point, nearest first, with their distance", async () => {
    const r = await searchLocations(
      store,
      [ONE, TWO],
      near({ radius_m: "3000" }),
    );
    expect(r.items.map((i) => i.name)).toEqual([
      "Station Square",
      "Market Hall",
      "Town Hall Garage",
      "Riverside Park",
    ]);
    expect(r.total).toBe(4);
    const d = r.items.map((i) => i.distance_m!);
    expect([...d].sort((a, b) => a - b)).toEqual(d);
    // The motorway site is about 9 km away; the unpublished depot never shows.
    expect(await names(near({ radius_m: "10000" }))).toContain(
      "Motorway Services North",
    );
    expect(await names(near({ radius_m: "50000" }))).not.toContain(
      "Fleet Depot",
    );
  });

  it("shows only the peers it is given", async () => {
    expect(await names(q({ q: "station" }), [ONE, TWO])).toEqual([
      "Station Square",
      "Station Square",
    ]);
    expect(await names(q({ q: "station" }), [TWO])).toHaveLength(1);
    expect(await names(q({}), [])).toEqual([]);
  });

  it("matches every word of a text search against name and address", async () => {
    expect(await names(q({ q: "market street" }), [ONE])).toEqual([
      "Market Hall",
    ]);
    expect(await names(q({ q: "1000 AD" }), [ONE])).toEqual(["Riverside Park"]);
    expect(await names(q({ q: "market garden" }), [ONE])).toEqual([]);
  });

  it("finds a charger by EVSE ID or by the reference printed on it", async () => {
    expect(await names(q({ evse_id: "zz*mck*e21" }))).toEqual(["Market Hall"]);
    expect(await names(q({ evse_id: "ZZMCKE21" }))).toEqual(["Market Hall"]);
    const byRef = await searchLocations(
      store,
      [ONE, TWO],
      q({ charger_id: "c1" }),
    );
    // Both peers have a C1: overlapping references, distinct results.
    expect(byRef.items.map((i) => i.matching_evse_count)).toEqual([1, 1]);
    expect(new Set(byRef.items.map((i) => i.id)).size).toBe(2);
    expect(await names(q({ charger_id: "LOC4" }), [ONE])).toEqual([
      "Riverside Park",
    ]);
    // A removed EVSE cannot be found.
    expect(await names(q({ charger_id: "E4" }), [ONE])).toEqual([]);
    expect(await names(q({ charger_id: "E3" }), [ONE])).toEqual([
      "Motorway Services North",
    ]);
  });

  it("filters by availability, power, connector, facilities, parking and price", async () => {
    const one = (params: Record<string, string>) => names(q(params), [ONE]);
    expect(await one({ status: "OUTOFORDER" })).toEqual(["Market Hall"]);
    expect(await one({ status: "PLANNED" })).toEqual([
      "Motorway Services North",
    ]);
    expect(await one({ min_power_kw: "150" })).toEqual([
      "Motorway Services North",
      "Station Square",
    ]);
    expect(await one({ max_power_kw: "11" })).toEqual([
      "Riverside Park",
      "Town Hall Garage",
    ]);
    expect(await one({ connector: "CHADEMO" })).toEqual(["Station Square"]);
    expect(await one({ facility: "WIFI,RESTAURANT" })).toEqual([
      "Motorway Services North",
    ]);
    expect(await one({ parking: "DISABLED" })).toEqual(["Town Hall Garage"]);
    expect(await one({ price: "free" })).toEqual(["Riverside Park"]);
    expect(await one({ price: "paid" })).not.toContain("Riverside Park");
    // Filters apply to the same EVSE: Market Hall's customers-only EVSE is excluded,
    // but its other available one still matches.
    const market = await searchLocations(
      store,
      [ONE],
      q({ q: "market", status: "AVAILABLE", exclude_parking: "CUSTOMERS" }),
    );
    expect(market.items[0].matching_evse_count).toBe(1);
    // The planned 300 kW EVSE is not available: only the two available ones count.
    const fast = await searchLocations(
      store,
      [ONE],
      q({ status: "AVAILABLE", min_power_kw: "300" }),
    );
    expect(fast.items[0].matching_evse_count).toBe(2);
  });

  it("summarises a location for the app", async () => {
    const [motorway] = (
      await searchLocations(store, [ONE], q({ q: "motorway" }))
    ).items;
    expect(motorway).toMatchObject({
      name: "Motorway Services North",
      city: "Sample City",
      country: "NLD",
      operator: "Sample Charging Operator",
      parking_type: "ALONG_MOTORWAY",
      facilities: ["FUEL_STATION", "RESTAURANT", "WIFI"],
      time_zone: "Europe/Amsterdam",
      evse_count: 3,
      available_count: 2,
      max_power_kw: 300,
      connector_standards: ["IEC_62196_T2_COMBO"],
      price: { free: false, summary: "€0.8349 per kWh" },
    });
    expect(parseLocationAppId(motorway.id)).toEqual({
      peerId: ONE,
      countryCode: "ZZ",
      partyId: "MCK",
      id: "LOC5",
    });
  });

  it("pages results", async () => {
    const all = await names(q({ limit: "100" }), [ONE]);
    expect(all).toHaveLength(5);
    expect(await names(q({ limit: "2", offset: "2" }), [ONE])).toEqual(
      all.slice(2, 4),
    );
  });
});

describe("geometry and IDs", () => {
  it("computes distances and boxes that contain the circle", () => {
    expect(
      Math.round(distanceM({ lat: 52, lng: 5 }, { lat: 53, lng: 5 }) / 1000),
    ).toBe(111);
    const box = boundingBox(52, 5, 10_000);
    expect(box.minLat).toBeLessThan(52 - 0.089);
    expect(box.maxLng! - 5).toBeGreaterThan(0.14);
    // Across the antimeridian: no longitude limits.
    expect(boundingBox(0, 179.99, 10_000).minLng).toBeUndefined();
  });

  it("round-trips app IDs and refuses anything else", () => {
    const key = { peerId: "p", countryCode: "ZZ", partyId: "MCK", id: "A/B" };
    expect(parseLocationAppId(locationAppId(key))).toEqual(key);
    expect(parseLocationAppId("not json")).toBeUndefined();
    expect(
      parseLocationAppId(Buffer.from("[1,2]").toString("base64url")),
    ).toBeUndefined();
  });
});

describe("location API in demo mode", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const k of [
      "EMSP_COUNTRY_CODE",
      "EMSP_PARTY_ID",
      "PUBLIC_BASE_URL",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "OCPI_TOKEN_ENCRYPTION_KEY",
    ])
      delete process.env[k];
    // Demo mode never reaches the network.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("demo mode must not call fetch");
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  const get = (path: string) =>
    new Request(`http://localhost:3000${path}`, { method: "GET" });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("searches the mock CPO's sample data, labelled demo, readable from any origin", async () => {
    const res = await searchRoute.GET(
      get(
        `/api/v1/locations?lat=${CENTER.lat}&lng=${CENTER.lng}&radius_m=3000`,
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.json();
    expect(body).toMatchObject({
      mode: "demo",
      total: 8,
      limit: 20,
      offset: 0,
    });
    expect(body.items[0].name).toBe("Station Square");
    expect(searchRoute.OPTIONS().status).toBe(204);

    const bad = await searchRoute.GET(get("/api/v1/locations?price=cheap"));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "price must be free or paid" });
  });

  it("returns a location's EVSEs, connectors and prices, and previews a session", async () => {
    const search = await (
      await searchRoute.GET(get("/api/v1/locations?q=town+hall"))
    ).json();
    const id = search.items[0].id;
    const detail = await (await detailRoute.GET(get(""), ctx(id))).json();
    expect(detail.mode).toBe("demo");
    expect(detail.location.evses).toHaveLength(2);
    expect(detail.location.evses[0]).toMatchObject({
      uid: "LOC3-1",
      floor_level: "-1",
      parking_restrictions: ["DISABLED", "EV_ONLY"],
      connectors: [
        {
          id: "1",
          standard: "IEC_62196_T2",
          max_power_kw: 11,
          price: {
            tariffId: "AC_PARKING",
            summary: "€0.4235 per kWh + €2.42 per hour parking",
          },
        },
      ],
    });

    const preview = await previewRoute.GET(
      get(
        `/api/v1/locations/${id}/price-preview?evse_uid=LOC3-1&connector_id=1&kwh=10&minutes=60&parking_minutes=61&start=2026-10-21T10:00:00Z`,
      ),
      ctx(id),
    );
    expect(await preview.json()).toMatchObject({
      mode: "demo",
      display_only: true,
      preview: { totalExclVat: 5.67, totalInclVat: 6.86, text: "€6.86" },
    });
  });

  it("answers 404 for unknown, unpublished or removed things, and 400 for bad input", async () => {
    const depot = locationAppId({
      peerId: "demo-mock-cpo",
      countryCode: "ZZ",
      partyId: "MCK",
      id: "LOC6",
    });
    expect((await detailRoute.GET(get(""), ctx(depot))).status).toBe(404);
    expect((await detailRoute.GET(get(""), ctx("garbage"))).status).toBe(404);
    const other = locationAppId({
      peerId: "someone-else",
      countryCode: "ZZ",
      partyId: "MCK",
      id: "LOC1",
    });
    expect((await detailRoute.GET(get(""), ctx(other))).status).toBe(404);
    const motorway = locationAppId({
      peerId: "demo-mock-cpo",
      countryCode: "ZZ",
      partyId: "MCK",
      id: "LOC5",
    });
    const removed = await previewRoute.GET(
      get(`/x?evse_uid=LOC5-4&connector_id=1&kwh=10&minutes=10`),
      ctx(motorway),
    );
    expect(removed.status).toBe(404);
    const missing = await previewRoute.GET(
      get(`/x?evse_uid=LOC5-1&connector_id=1&minutes=10`),
      ctx(motorway),
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "kwh is required" });
  });
});
