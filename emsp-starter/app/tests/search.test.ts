import { describe, expect, it } from "vitest";
import { SAMPLE_LOCATIONS } from "../src/lib/api";
import { cluster } from "../src/lib/cluster";
import { isOpenAt } from "../src/lib/hours";
import {
  classify,
  NO_FILTERS,
  openNowFilter,
  searchParams,
  searchSample,
  type Filters,
  type Search,
} from "../src/lib/search";
import { placeKind } from "../src/lib/status";

const CENTER = { lat: 52.09074, lng: 5.12142 };
type Q = Partial<Omit<Search, "filters">> & { filters?: Partial<Filters> };
const run = (s: Q) =>
  searchSample(SAMPLE_LOCATIONS, {
    text: "",
    ...s,
    filters: { ...NO_FILTERS, ...s.filters },
  });
const names = (s: Q) => run(s).items.map((i) => i.name);

describe("the search box", () => {
  it("tells an EVSE ID, a charger reference and a place apart", () => {
    expect(classify("NL*ABC*E12345")).toEqual({
      kind: "evse",
      value: "NL*ABC*E12345",
    });
    expect(classify(" zz*mck*e11 ")?.kind).toBe("evse");
    expect(classify("A1")).toEqual({ kind: "charger", value: "A1" });
    expect(classify("market hall")).toEqual({
      kind: "text",
      value: "market hall",
    });
    expect(classify("Stationsplein")?.kind).toBe("text");
    expect(classify("   ")).toBeNull();
  });

  it("asks the server with its own parameters", () => {
    const q = searchParams({
      text: "ZZ*MCK*E11",
      filters: {
        ...NO_FILTERS,
        available: true,
        minPowerKw: 50,
        connector: "CCS",
        stepFree: true,
        price: "paid",
        openNow: true,
      },
      near: { ...CENTER, radiusM: 5000 },
    });
    expect(Object.fromEntries(q)).toEqual({
      evse_id: "ZZ*MCK*E11",
      status: "AVAILABLE",
      min_power_kw: "50",
      connector: "IEC_62196_T2_COMBO",
      parking: "DISABLED",
      price: "paid",
      lat: "52.090740",
      lng: "5.121420",
      radius_m: "5000",
      limit: "100",
    });
    expect(searchParams({ text: "market", filters: NO_FILTERS }).get("q")).toBe(
      "market",
    );
    expect(
      searchParams({ text: "B2", filters: NO_FILTERS }).get("charger_id"),
    ).toBe("B2");
  });
});

describe("the offline demo's search", () => {
  it("lists every sample place, by name, or nearest first", () => {
    expect(run({}).items).toHaveLength(SAMPLE_LOCATIONS.length);
    const byName = names({});
    expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b)));
    const near = run({ near: { ...CENTER, radiusM: 3000 } }).items;
    expect(near[0].distance_m).toBeLessThanOrEqual(near[1].distance_m!);
    expect(near.every((l) => l.distance_m! <= 3000)).toBe(true);
  });

  it("finds a place by words, a charger by its reference and an EVSE by its ID", () => {
    expect(names({ text: "market hall" })).toEqual(["Market Hall"]);
    expect(names({ text: "plaza" })).toEqual(["Library Plaza"]);
    expect(names({ text: "zz-mck-e11" })).toEqual(["Station Square"]);
    expect(run({ text: "ZZ*MCK*E11" }).items[0].matching_evse_count).toBe(1);
    expect(names({ text: "nowhere at all" })).toEqual([]);
  });

  it("filters by availability, power, connector, step-free access and price", () => {
    const all = (f: Partial<Filters>) => run({ filters: f }).items;
    expect(all({ minPowerKw: 150 }).every((l) => l.max_power_kw >= 150)).toBe(
      true,
    );
    expect(
      all({ connector: "CHADEMO" }).every((l) =>
        l.connector_standards.includes("CHADEMO"),
      ),
    ).toBe(true);
    expect(all({ available: true }).every((l) => l.available_count > 0)).toBe(
      true,
    );
    expect(all({ stepFree: true }).map((l) => l.name)).toContain(
      "Town Hall Garage",
    );
    expect(all({ price: "free" }).map((l) => l.name)).toContain(
      "Riverside Park",
    );
    expect(all({ price: "paid" }).map((l) => l.name)).not.toContain(
      "Riverside Park",
    );
  });

  it("filters on open now in the place's own time zone", () => {
    const garage = SAMPLE_LOCATIONS.find((l) => l.name === "Town Hall Garage")!;
    // 06:30 on a Monday in Amsterdam: before 07:00, closed.
    const early = new Date("2026-10-26T05:30:00Z");
    expect(isOpenAt(garage.opening_times, garage.time_zone, early)).toBe(false);
    expect(
      isOpenAt(
        garage.opening_times,
        garage.time_zone,
        new Date("2026-10-26T09:00:00Z"),
      ),
    ).toBe(true);
    const items = run({}).items;
    const open = openNowFilter(items, { ...NO_FILTERS, openNow: true }, early);
    expect(open.map((l) => l.name)).not.toContain("Town Hall Garage");
    expect(open.length).toBe(items.length - 2);
  });
});

describe("opening hours", () => {
  it("handles periods past midnight and closures", () => {
    const night = {
      twentyfourseven: false,
      regular_hours: [
        { weekday: 5, period_begin: "22:00", period_end: "06:00" },
      ],
    };
    // Friday 23:00 and Saturday 05:00 UTC.
    expect(isOpenAt(night, "UTC", new Date("2026-10-23T23:00:00Z"))).toBe(true);
    expect(isOpenAt(night, "UTC", new Date("2026-10-24T05:00:00Z"))).toBe(true);
    expect(isOpenAt(night, "UTC", new Date("2026-10-24T07:00:00Z"))).toBe(
      false,
    );
    expect(
      isOpenAt(
        {
          twentyfourseven: true,
          exceptional_closings: [
            {
              period_begin: "2026-12-25T00:00:00Z",
              period_end: "2026-12-26T00:00:00Z",
            },
          ],
        },
        "UTC",
        new Date("2026-12-25T12:00:00Z"),
      ),
    ).toBe(false);
    expect(isOpenAt(undefined, "UTC")).toBeUndefined();
  });
});

describe("clusters", () => {
  const items = SAMPLE_LOCATIONS;
  it("group nearby chargers when zoomed out and none when zoomed in", () => {
    const far = cluster(items, 8);
    expect(far.length).toBeLessThan(items.length);
    const counted = far.reduce(
      (n, g) => n + (g.kind === "cluster" ? g.count : 1),
      0,
    );
    expect(counted).toBe(items.length);
    expect(cluster(items, 18).every((g) => g.kind === "point")).toBe(true);
  });
  it("are stable for the same input", () => {
    expect(cluster(items, 12).map((g) => g.key)).toEqual(
      cluster(items, 12).map((g) => g.key),
    );
  });
});

describe("place status", () => {
  it("is free, in use, out of order or unknown", () => {
    expect(
      placeKind({ available_count: 1, status_counts: { AVAILABLE: 1 } }),
    ).toBe("free");
    expect(
      placeKind({
        available_count: 0,
        status_counts: { CHARGING: 1, OUTOFORDER: 1 },
      }),
    ).toBe("busy");
    expect(
      placeKind({ available_count: 0, status_counts: { OUTOFORDER: 2 } }),
    ).toBe("down");
    expect(
      placeKind({ available_count: 0, status_counts: { PLANNED: 1 } }),
    ).toBe("unknown");
    expect(placeKind({ available_count: 0 })).toBe("unknown");
  });
});
