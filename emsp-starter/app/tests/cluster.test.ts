import { describe, expect, it } from "vitest";
import {
  cluster,
  CLUSTER_MAX_ZOOM,
  tapOpensChooser,
  type Clustered,
} from "../src/lib/cluster";

const SPOT = { lat: 52.09274, lng: 5.12542 };
const at = (id: string, north = 0) => ({
  id,
  // One degree of latitude is about 111 km: `north` is in metres.
  coordinates: { lat: SPOT.lat + north / 111_195, lng: SPOT.lng },
});
/** Sixteen places sent with one coordinate. */
const stack = Array.from({ length: 16 }, (_, i) => at(`s${i}`));

const shape = <T extends { id: string }>(groups: Clustered<T>[]) =>
  groups.map((g) =>
    g.kind === "point"
      ? g.item.id
      : { ids: g.items.map((i) => i.id), sameSpot: g.sameSpot },
  );

describe("places at one coordinate", () => {
  it("stay one cluster at every zoom, so no pin hides under another", () => {
    for (const zoom of [3, 12, 15.5, CLUSTER_MAX_ZOOM, 17, 18, 22]) {
      const groups = cluster(stack, zoom);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({
        kind: "cluster",
        count: 16,
        sameSpot: true,
      });
      expect(groups[0].at.lat).toBeCloseTo(SPOT.lat, 9);
      expect(groups[0].at.lng).toBeCloseTo(SPOT.lng, 9);
    }
  });

  it("keep their order in the results", () => {
    const [g] = cluster(stack, 18);
    expect(g.kind === "cluster" && g.items.map((i) => i.id)).toEqual(
      stack.map((i) => i.id),
    );
  });

  it("absorb rounding in the data, but not a few metres", () => {
    expect(shape(cluster([at("a"), at("b", 0.5)], 18))).toEqual([
      { ids: ["a", "b"], sameSpot: true },
    ]);
    expect(shape(cluster([at("a"), at("b", 3)], 18))).toEqual(["a", "b"]);
  });

  it("part from their neighbours once zoomed in, wherever they are in the list", () => {
    const items = [at("a"), at("near", 40), at("b")];
    const far = cluster(items, 12);
    expect(shape(far)).toEqual([{ ids: ["a", "near", "b"], sameSpot: false }]);
    expect(shape(cluster(items, CLUSTER_MAX_ZOOM))).toEqual([
      { ids: ["a", "b"], sameSpot: true },
      "near",
    ]);
  });
});

describe("a tap on a cluster", () => {
  const apart = [at("a"), at("b", 40)];

  it("zooms in while zoom can still separate its places", () => {
    const [g] = cluster(apart, 12);
    expect(g.kind === "cluster" && tapOpensChooser(g, 12)).toBe(false);
    expect(shape(cluster(apart, 17))).toEqual(["a", "b"]);
  });

  it("opens the chooser for one coordinate, at any zoom", () => {
    for (const zoom of [3, 12, 17]) {
      const [g] = cluster(stack, zoom);
      expect(g.kind === "cluster" && tapOpensChooser(g, zoom)).toBe(true);
    }
  });

  it("opens the chooser once the zoom is at its maximum", () => {
    const group = { sameSpot: false };
    expect(tapOpensChooser(group, CLUSTER_MAX_ZOOM - 0.5)).toBe(false);
    expect(tapOpensChooser(group, CLUSTER_MAX_ZOOM)).toBe(true);
  });
});
