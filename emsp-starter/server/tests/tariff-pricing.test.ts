import { describe, expect, it } from "vitest";
import { sampleTariffs } from "@/lib/mock-cpo/sample-data";
import {
  describeRestrictions,
  displayPrice,
  formatMoney,
  isFreeTariff,
  previewCost,
  primaryTariff,
  restrictionsMatch,
  tariffActive,
} from "@/lib/locations/pricing";
import type { Tariff } from "@/lib/ocpi/tariffs";

const PARTY = { countryCode: "ZZ", partyId: "MCK" };
const SAMPLE = Object.fromEntries(
  sampleTariffs(PARTY).map((t) => [t.id, t]),
) as Record<string, Tariff>;

const tariff = (elements: Tariff["elements"], extra: Partial<Tariff> = {}) =>
  ({
    country_code: "ZZ",
    party_id: "MCK",
    id: "T",
    currency: "EUR",
    elements,
    last_updated: "2026-10-01T00:00:00Z",
    ...extra,
  }) as Tariff;

const AMSTERDAM = "Europe/Amsterdam";

describe("display price", () => {
  it("shows energy and an idle fee with its condition, VAT included", () => {
    const p = displayPrice(SAMPLE.DC_FAST);
    expect(p).toMatchObject({
      tariffId: "DC_FAST",
      currency: "EUR",
      type: "REGULAR",
      free: false,
      altText: "0.59 per kWh. After 45 minutes, 6.00 per hour.",
    });
    expect(p.components).toEqual([
      {
        type: "ENERGY",
        unit: "kWh",
        price: expect.closeTo(0.7139, 6),
        vatIncluded: true,
        text: "€0.7139 per kWh",
        conditions: [],
      },
      {
        type: "TIME",
        unit: "hour",
        price: expect.closeTo(7.26, 6),
        vatIncluded: true,
        text: "€7.26 per hour",
        conditions: ["after 45 min"],
      },
    ]);
    expect(p.summary).toBe("€0.7139 per kWh + €7.26 per hour (after 45 min)");
  });

  it("names time-of-day windows and the fallback element", () => {
    const p = displayPrice(SAMPLE.AC_DAY_NIGHT);
    expect(p.components.map((c) => [c.text, c.conditions])).toEqual([
      ["€0.605 per session", []],
      ["€0.4719 per kWh", ["Mon–Fri", "07:00–21:00"]],
      ["€0.3509 per kWh", ["otherwise"]],
    ]);
    expect(p.summary).toBe(
      "€0.605 per session + €0.4719 per kWh (Mon–Fri, 07:00–21:00); varies at other times",
    );
  });

  it("shows parking, free tariffs and min price; says when VAT is not included", () => {
    expect(displayPrice(SAMPLE.AC_PARKING).summary).toBe(
      "€0.4235 per kWh + €2.42 per hour parking",
    );
    expect(displayPrice(SAMPLE.FREE)).toMatchObject({
      free: true,
      summary: "Free",
    });
    expect(displayPrice(SAMPLE.HPC).minPrice).toBe("€1.21");
    const noVat = tariff(
      [{ price_components: [{ type: "FLAT", price: 2, step_size: 1 }] }],
      { max_price: { excl_vat: 30 } },
    );
    expect(displayPrice(noVat)).toMatchObject({
      summary: "€2.00 per session excl. VAT",
      maxPrice: "€30.00 excl. VAT",
    });
  });

  it("describes every kind of restriction", () => {
    expect(
      describeRestrictions({
        day_of_week: ["SATURDAY", "SUNDAY"],
        start_time: "22:00",
        end_time: "06:00",
        start_date: "2026-11-01",
        end_date: "2027-01-01",
        min_duration: 3600,
        max_duration: 7200,
        min_kwh: 10,
        max_power: 22,
        min_current: 16,
        reservation: "RESERVATION",
      }),
    ).toEqual([
      "Sat, Sun",
      "22:00–06:00",
      "from 2026-11-01",
      "before 2027-01-01",
      "1 h to 2 h",
      "from 10 kWh",
      "below 22 kW",
      "at 16 A or more",
      "while reserved",
    ]);
    expect(
      describeRestrictions({
        day_of_week: ["MONDAY", "TUESDAY", "WEDNESDAY", "FRIDAY"],
        max_duration: 90,
      }),
    ).toEqual(["Mon–Wed, Fri", "first 90 s"]);
  });

  it("formats money with the currency's own decimals", () => {
    expect(formatMoney(1.5, "EUR")).toBe("€1.50");
    expect(formatMoney(0.345, "GBP")).toBe("£0.345");
    expect(formatMoney(120, "JPY")).toBe("¥120");
  });
});

describe("which tariff applies", () => {
  it("is free only when every component is zero and there is no minimum", () => {
    expect(isFreeTariff(SAMPLE.FREE)).toBe(true);
    expect(isFreeTariff(SAMPLE.HPC)).toBe(false);
    const zeroWithMin = tariff(
      [{ price_components: [{ type: "ENERGY", price: 0, step_size: 1 }] }],
      { min_price: { excl_vat: 1 } },
    );
    expect(isFreeTariff(zeroWithMin)).toBe(false);
  });

  it("prefers a REGULAR tariff over ad-hoc, and skips tariffs out of their dates", () => {
    const all = Object.values(SAMPLE);
    expect(primaryTariff(["HPC_ADHOC", "HPC"], all)?.id).toBe("HPC");
    expect(primaryTariff(["HPC_ADHOC"], all)?.id).toBe("HPC_ADHOC");
    expect(primaryTariff(["UNKNOWN"], all)).toBeUndefined();
    expect(primaryTariff(undefined, all)).toBeUndefined();
    const future = { ...SAMPLE.HPC, start_date_time: "2027-01-01T00:00:00Z" };
    const now = new Date("2026-10-21T12:00:00Z");
    expect(tariffActive(future, now)).toBe(false);
    expect(
      primaryTariff(["HPC", "HPC_ADHOC"], [future, SAMPLE.HPC_ADHOC], now)?.id,
    ).toBe("HPC_ADHOC");
    const ended = { ...SAMPLE.HPC, end_date_time: "2026-10-21T12:00:00Z" };
    expect(tariffActive(ended, now)).toBe(false);
  });

  it("matches restrictions with OCPI's inclusive minimum and exclusive maximum", () => {
    const at = (minutes: number, extra = {}) => ({
      minutes,
      date: "2026-10-21",
      day: "WEDNESDAY",
      kwh: 5,
      powerKw: 11,
      seconds: 600,
      ...extra,
    });
    const night = { start_time: "22:00", end_time: "06:00" };
    expect(restrictionsMatch(night, at(23 * 60))).toBe(true);
    expect(restrictionsMatch(night, at(5 * 60 + 59))).toBe(true);
    expect(restrictionsMatch(night, at(6 * 60))).toBe(false);
    expect(restrictionsMatch(night, at(12 * 60))).toBe(false);
    expect(restrictionsMatch({ min_kwh: 5 }, at(0))).toBe(true);
    expect(restrictionsMatch({ max_kwh: 5 }, at(0))).toBe(false);
    expect(restrictionsMatch({ min_duration: 600 }, at(0))).toBe(true);
    expect(restrictionsMatch({ max_duration: 600 }, at(0))).toBe(false);
    expect(restrictionsMatch({ day_of_week: ["MONDAY"] }, at(0))).toBe(false);
    expect(restrictionsMatch({ end_date: "2026-10-21" }, at(0))).toBe(false);
    expect(restrictionsMatch({ start_date: "2026-10-21" }, at(0))).toBe(true);
    // Unknown current: current restrictions are not held against the session.
    expect(restrictionsMatch({ min_current: 32 }, at(0))).toBe(true);
    expect(
      restrictionsMatch({ min_current: 32 }, at(0, { currentA: 16 })),
    ).toBe(false);
    expect(restrictionsMatch({ reservation: "RESERVATION" }, at(0))).toBe(
      false,
    );
  });
});

describe("price preview", () => {
  it("charges energy, then an idle fee after 45 minutes", () => {
    const p = previewCost(SAMPLE.DC_FAST, {
      start: new Date("2026-10-21T10:00:00Z"),
      energyKwh: 30,
      chargingMinutes: 60,
      timeZone: AMSTERDAM,
    });
    expect(p.lines).toEqual([
      {
        type: "ENERGY",
        quantity: 30,
        unitPrice: 0.59,
        amountExclVat: 17.7,
        vat: 21,
      },
      {
        type: "TIME",
        quantity: 0.25,
        unitPrice: 6,
        amountExclVat: 1.5,
        vat: 21,
      },
    ]);
    expect(p).toMatchObject({
      currency: "EUR",
      totalExclVat: 19.2,
      totalInclVat: 23.23,
      text: "€23.23",
    });
  });

  it("switches rate at 21:00 local time on a weekday, and stays on the night rate at the weekend", () => {
    // 18:30 UTC is 20:30 in Amsterdam (summer time until 25 October 2026).
    const weekday = previewCost(SAMPLE.AC_DAY_NIGHT, {
      start: new Date("2026-10-21T18:30:00Z"),
      energyKwh: 11,
      chargingMinutes: 60,
      timeZone: AMSTERDAM,
    });
    expect(weekday.lines.map((l) => [l.type, l.unitPrice, l.quantity])).toEqual(
      [
        ["FLAT", 0.5, 1],
        ["ENERGY", 0.39, 5.5],
        ["ENERGY", 0.29, 5.5],
      ],
    );
    expect(weekday.totalExclVat).toBe(4.24);
    expect(weekday.totalInclVat).toBe(5.13);

    const saturday = previewCost(SAMPLE.AC_DAY_NIGHT, {
      start: new Date("2026-10-24T10:00:00Z"),
      energyKwh: 10,
      chargingMinutes: 60,
      timeZone: AMSTERDAM,
    });
    expect(saturday.totalExclVat).toBe(3.4);
    // In UTC the same instant is still a weekday evening at 18:30: day rate first.
    const utc = previewCost(SAMPLE.AC_DAY_NIGHT, {
      start: new Date("2026-10-21T18:30:00Z"),
      energyKwh: 11,
      chargingMinutes: 60,
    });
    expect(utc.lines.find((l) => l.unitPrice === 0.39)?.quantity).toBe(11);
  });

  it("bills parking after charging, rounded up to the step size", () => {
    const p = previewCost(SAMPLE.AC_PARKING, {
      start: new Date("2026-10-21T10:00:00Z"),
      energyKwh: 10,
      chargingMinutes: 60,
      parkingMinutes: 61,
      timeZone: AMSTERDAM,
    });
    // 61 minutes in 5-minute steps: 65 minutes.
    expect(p.lines.find((l) => l.type === "PARKING_TIME")).toMatchObject({
      quantity: 1.0833,
      amountExclVat: 2.1667,
    });
    expect(p.totalExclVat).toBe(5.67);
    expect(p.totalInclVat).toBe(6.86);
  });

  it("applies energy tiers and power bands", () => {
    const tiers = tariff([
      {
        price_components: [{ type: "ENERGY", price: 0.3, step_size: 1 }],
        restrictions: { max_kwh: 10 },
      },
      { price_components: [{ type: "ENERGY", price: 0.2, step_size: 1 }] },
    ]);
    const t = previewCost(tiers, {
      start: new Date("2026-10-21T10:00:00Z"),
      energyKwh: 20,
      chargingMinutes: 20,
    });
    expect(t.lines.map((l) => [l.unitPrice, l.quantity])).toEqual([
      [0.3, 10],
      [0.2, 10],
    ]);
    expect(t.totalExclVat).toBe(5);
    // No VAT rate given: no total with VAT.
    expect(t.totalInclVat).toBeNull();
    expect(t.text).toBe("€5.00 excl. VAT");

    const bands = tariff([
      {
        price_components: [{ type: "ENERGY", price: 0.5, step_size: 1 }],
        restrictions: { min_power: 50 },
      },
      { price_components: [{ type: "ENERGY", price: 0.3, step_size: 1 }] },
    ]);
    const start = new Date("2026-10-21T10:00:00Z");
    expect(
      previewCost(bands, { start, energyKwh: 50, chargingMinutes: 30 })
        .totalExclVat,
    ).toBe(25);
    expect(
      previewCost(bands, { start, energyKwh: 11, chargingMinutes: 60 })
        .totalExclVat,
    ).toBe(3.3);
  });

  it("applies min_price and max_price to the total", () => {
    const min = previewCost(SAMPLE.HPC, {
      start: new Date("2026-10-21T10:00:00Z"),
      energyKwh: 1,
      chargingMinutes: 2,
    });
    expect(min).toMatchObject({
      bounded: "min",
      totalExclVat: 1,
      totalInclVat: 1.21,
      text: "€1.21",
    });
    const capped = tariff(
      [
        {
          price_components: [
            { type: "TIME", price: 10, vat: 20, step_size: 1 },
          ],
        },
      ],
      { max_price: { excl_vat: 15 } },
    );
    const max = previewCost(capped, {
      start: new Date("2026-10-21T10:00:00Z"),
      energyKwh: 30,
      chargingMinutes: 180,
    });
    expect(max).toMatchObject({
      bounded: "max",
      totalExclVat: 15,
      totalInclVat: null,
    });
  });

  it("previews a free tariff as free, and an empty session as only the flat fee", () => {
    const free = previewCost(SAMPLE.FREE, {
      start: new Date("2026-10-21T10:00:00Z"),
      energyKwh: 7,
      chargingMinutes: 60,
    });
    expect(free).toMatchObject({
      totalExclVat: 0,
      totalInclVat: 0,
      text: "€0.00",
    });
    const flat = previewCost(SAMPLE.AC_DAY_NIGHT, {
      start: new Date("2026-10-21T10:00:00Z"),
      energyKwh: 0,
      chargingMinutes: 0,
    });
    expect(flat.totalExclVat).toBe(0.5);
  });

  it("reads an unknown time zone as UTC", () => {
    const p = previewCost(SAMPLE.AC_DAY_NIGHT, {
      start: new Date("2026-10-21T18:30:00Z"),
      energyKwh: 11,
      chargingMinutes: 60,
      timeZone: "Not/AZone",
    });
    expect(p.lines.find((l) => l.unitPrice === 0.39)?.quantity).toBe(11);
  });
});
