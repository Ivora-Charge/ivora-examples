import { describe, expect, it } from "vitest";
import { demoLocationStore } from "@/lib/locations/registry";
import { displayPrice } from "@/lib/locations/pricing";

describe("demo mode shows a CAD sample next to the EUR one", () => {
  it("has CAD locations in Toronto whose tariffs are priced in CAD", () => {
    const store = demoLocationStore();
    const tariffs = [...store.tariffs.values()].map((t) => t.tariff);
    const cad = tariffs.filter((t) => t.currency === "CAD");
    expect(cad.length).toBeGreaterThan(0);
    expect(tariffs.some((t) => t.currency === "EUR")).toBe(true);
    const locations = [...store.locations.values()].map((l) => l.location);
    const toronto = locations.filter((l) => l.city === "Toronto");
    expect(toronto.map((l) => l.name)).toEqual([
      "Harbourfront Garage",
      "Maple Court Charging",
    ]);
    const texts = cad.flatMap((t) =>
      displayPrice(t).components.map((c) => c.text),
    );
    expect(texts.some((x) => x.includes("CA$"))).toBe(true);
    expect(texts.some((x) => x.includes("€"))).toBe(false);
  });
});
