import { describe, expect, it } from "vitest";
import { sampleLocations, sampleTariffs } from "@/lib/mock-cpo/sample-data";
import {
  connectorPowerW,
  parseConnector,
  parseEvse,
  parseLocation,
  parsePatch,
} from "@/lib/ocpi/locations";
import { parseTariff } from "@/lib/ocpi/tariffs";

const PARTY = { countryCode: "ZZ", partyId: "MCK" };
const [location] = sampleLocations(PARTY);
const evse = location.evses![0];
const connector = evse.connectors[0];
const [tariff] = sampleTariffs(PARTY);

const errors = (r: { ok: boolean; errors?: string[] }) =>
  r.ok ? [] : (r as { errors: string[] }).errors;

describe("OCPI 2.2.1 location validation", () => {
  it("accepts every sample location and tariff unchanged", () => {
    for (const l of sampleLocations(PARTY, 12))
      expect(parseLocation(l)).toEqual({ ok: true, value: l });
    for (const t of sampleTariffs(PARTY))
      expect(parseTariff(t)).toEqual({ ok: true, value: t });
  });

  it("drops fields it does not keep, and upper-cases the party", () => {
    const r = parseLocation({
      ...location,
      country_code: "zz",
      party_id: "mck",
      energy_mix: { is_green_energy: true },
      related_locations: [],
      vendor_extension: { anything: 1 },
    });
    expect(r.ok && r.value).toEqual(location);
  });

  it("requires the mandatory fields", () => {
    const { address: _, coordinates: __, time_zone: ___, ...rest } = location;
    expect(errors(parseLocation(rest))).toEqual([
      "location.address must be a string of 1 to 45 characters",
      "location.coordinates must be an object",
      "location.time_zone must be a string of 1 to 255 characters",
    ]);
    expect(errors(parseLocation({ ...location, publish: "yes" }))).toEqual([
      "location.publish must be a boolean",
    ]);
    expect(errors(parseLocation(null))).toEqual(["location must be an object"]);
  });

  it("checks coordinates, enums, dates and duplicate IDs, naming fields but never values", () => {
    const bad = parseLocation({
      ...location,
      coordinates: { latitude: "52.1", longitude: "5.12" },
      facilities: ["HOTEL", "SPACEPORT"],
      last_updated: "yesterday",
      evses: [evse, { ...evse }],
    });
    expect(errors(bad)).toEqual([
      "location.coordinates.latitude has an invalid format",
      "location.coordinates.longitude has an invalid format",
      "location.last_updated must be a DateTime",
      "location.facilities[1] must be one of the OCPI 2.2.1 values",
    ]);
    expect(JSON.stringify(errors(bad))).not.toMatch(/SPACEPORT|yesterday/);
    expect(errors(parseLocation({ ...location, evses: [evse, evse] }))).toEqual(
      ["location.evses has duplicate uids"],
    );
    expect(
      errors(
        parseLocation({
          ...location,
          coordinates: { latitude: "52.000000", longitude: "500.000000" },
        }),
      ),
    ).toEqual(["location.coordinates is out of range"]);
  });

  it("validates EVSEs and connectors on their own", () => {
    expect(parseEvse(evse)).toEqual({ ok: true, value: evse });
    expect(errors(parseEvse({ ...evse, status: "BROKEN" }))).toEqual([
      "evse.status must be one of the OCPI 2.2.1 values",
    ]);
    expect(errors(parseEvse({ ...evse, connectors: [] }))).toEqual([
      "evse.connectors must be an array of 1 to 50 items",
    ]);
    expect(parseConnector(connector)).toEqual({ ok: true, value: connector });
    expect(
      errors(
        parseConnector({ ...connector, max_voltage: -1, standard: "USB" }),
      ),
    ).toEqual([
      "connector.standard must be one of the OCPI 2.2.1 values",
      "connector.max_voltage must be a whole number from 0 to 100000",
    ]);
  });

  it("needs last_updated in a PATCH", () => {
    expect(parsePatch({ status: "CHARGING" }).ok).toBe(false);
    expect(
      parsePatch({ status: "CHARGING", last_updated: "2026-10-21T10:00:00Z" })
        .ok,
    ).toBe(true);
    expect(parsePatch([]).ok).toBe(false);
  });

  it("works out a connector's power from volts, amps and phases", () => {
    const { max_electric_power: _, ...ac } = {
      ...connector,
      power_type: "AC_3_PHASE" as const,
      max_voltage: 230,
      max_amperage: 32,
    };
    expect(connectorPowerW(ac)).toBe(22_080);
    expect(connectorPowerW({ ...ac, power_type: "AC_1_PHASE" })).toBe(7_360);
    expect(connectorPowerW({ ...ac, max_electric_power: 50_000 })).toBe(50_000);
  });
});

describe("OCPI 2.2.1 tariff validation", () => {
  it("checks components, restrictions, prices and dates", () => {
    const bad = parseTariff({
      ...tariff,
      currency: "eur",
      elements: [
        {
          price_components: [{ type: "KWH", price: -1, step_size: 1.5 }],
          restrictions: { start_time: "25:00", day_of_week: ["FUNDAY"] },
        },
      ],
      min_price: { excl_vat: "1" },
    });
    expect(errors(bad)).toEqual([
      "tariff.currency has an invalid format",
      "tariff.elements[0].price_components[0].type must be one of the OCPI 2.2.1 values",
      "tariff.elements[0].price_components[0].price must be a number of at least 0",
      "tariff.elements[0].price_components[0].step_size must be a whole number from 0 to 100000000",
      "tariff.elements[0].restrictions.start_time has an invalid format",
      "tariff.elements[0].restrictions.day_of_week[0] must be one of the OCPI 2.2.1 values",
      "tariff.min_price.excl_vat must be a number of at least 0",
    ]);
    expect(errors(parseTariff({ ...tariff, elements: [] }))).toEqual([
      "tariff.elements must be an array of 1 to 100 items",
    ]);
  });

  it("drops empty restrictions", () => {
    const r = parseTariff({
      ...tariff,
      elements: [{ ...tariff.elements[0], restrictions: {} }],
    });
    expect(r.ok && r.value.elements[0]).toEqual(tariff.elements[0]);
  });
});
