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
        priceE4: 7139,
        vatIncluded: true,
        text: "€0.7139 per kWh",
        conditions: [],
      },
      {
        type: "TIME",
        unit: "hour",
        priceE4: 72600,
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

describe("the price that applies now", () => {
  type Element = Tariff["elements"][number];
  type Component = Element["price_components"][number];
  const rate = (
    type: Component["type"],
    price: number,
    restrictions?: Element["restrictions"],
  ): Element => ({
    price_components: [{ type, price, step_size: 1 }],
    ...(restrictions ? { restrictions } : {}),
  });
  /** A Thursday, 12:00 in Amsterdam. */
  const NOON = new Date("2026-10-01T10:00:00Z");
  const nowOf = (
    t: Tariff,
    at = NOON,
    timeZone = AMSTERDAM,
    limits: { maxPowerKw?: number; maxCurrentA?: number } = {},
  ) => {
    const now = displayPrice(t, { at, timeZone, ...limits }).now!;
    const read = (list: typeof now.components) =>
      list.map((c) => [c.type, c.priceE4, c.conditions.join(", ")]);
    return {
      now: read(now.components),
      // Only when there are any, so that the other cases read shorter.
      ...(now.tiers.length ? { tiers: read(now.tiers) } : {}),
      others: read(now.others),
      unexplained: now.unexplained,
    };
  };

  it("is left out without a moment", () => {
    expect(displayPrice(SAMPLE.DC_FAST)).not.toHaveProperty("now");
  });

  // 6 TIME and 2 ENERGY components, none with restrictions.
  const unexplained = [
    rate("TIME", 0.66),
    rate("TIME", 1.2),
    rate("TIME", 1.8),
    rate("ENERGY", 0.11),
    rate("TIME", 2.4),
    rate("TIME", 3),
    rate("ENERGY", 0.22),
    rate("TIME", 3.6),
  ];

  it.each([
    ["an element each", unexplained],
    [
      "all in one element",
      [{ price_components: unexplained.flatMap((e) => e.price_components) }],
    ],
  ])(
    "takes the first of several rates without conditions (%s)",
    (_, elements) => {
      const t = tariff(elements, { min_price: { excl_vat: 0.5 } });
      expect(nowOf(t)).toEqual({
        now: [
          ["ENERGY", 1100, ""],
          ["TIME", 6600, ""],
        ],
        others: [],
        unexplained: true,
      });
      expect(displayPrice(t).minPrice).toBe("€0.50 excl. VAT");
      // Every component is still sent, and the preview charges the same two.
      expect(displayPrice(t).components).toHaveLength(8);
      expect(
        previewCost(t, {
          start: NOON,
          energyKwh: 10,
          chargingMinutes: 60,
        }).lines.map((l) => [l.type, l.unitPriceE4]),
      ).toEqual([
        ["ENERGY", 1100],
        ["TIME", 6600],
      ]);
    },
  );

  it("does not call the same rate listed twice another rate", () => {
    const t = tariff([rate("ENERGY", 0.3), rate("ENERGY", 0.3)]);
    expect(nowOf(t)).toEqual({
      now: [["ENERGY", 3000, ""]],
      others: [],
      unexplained: false,
    });
  });

  it("keeps a fee that starts after 2 h for later", () => {
    const t = tariff([
      rate("ENERGY", 0.4),
      rate("TIME", 3, { min_duration: 7200 }),
      rate("FLAT", 0.5),
    ]);
    expect(nowOf(t)).toEqual({
      now: [
        ["ENERGY", 4000, ""],
        ["FLAT", 5000, ""],
      ],
      others: [["TIME", 30000, "after 2 h"]],
      unexplained: false,
    });
  });

  it("falls back to the rate after the one that starts after 2 h", () => {
    const t = tariff([
      rate("TIME", 3, { min_duration: 7200 }),
      rate("TIME", 1),
    ]);
    expect(nowOf(t)).toEqual({
      now: [["TIME", 10000, ""]],
      others: [["TIME", 30000, "after 2 h"]],
      unexplained: false,
    });
  });

  it("lists a conditional rate placed after one that always applies", () => {
    const t = tariff([
      rate("TIME", 1),
      rate("TIME", 3, { min_duration: 7200 }),
    ]);
    expect(nowOf(t)).toEqual({
      now: [["TIME", 10000, ""]],
      others: [["TIME", 30000, "after 2 h"]],
      unexplained: false,
    });
  });

  it("shows the first period until it is used up", () => {
    const t = tariff([
      rate("TIME", 0, { max_duration: 1800 }),
      rate("ENERGY", 0.2, { max_kwh: 10 }),
      rate("TIME", 2),
      rate("ENERGY", 0.5),
    ]);
    expect(nowOf(t)).toEqual({
      now: [
        ["ENERGY", 2000, "up to 10 kWh"],
        ["TIME", 0, "first 30 min"],
      ],
      others: [
        ["ENERGY", 5000, "otherwise"],
        ["TIME", 20000, "otherwise"],
      ],
      unexplained: false,
    });
  });

  it("reads days and times on the location's clock", () => {
    const at = (iso: string, zone = AMSTERDAM) =>
      nowOf(SAMPLE.AC_DAY_NIGHT, new Date(iso), zone);
    // Thursday 12:00 in Amsterdam: the weekday day rate.
    expect(at("2026-10-01T10:00:00Z")).toEqual({
      now: [
        ["ENERGY", 4719, "Mon–Fri, 07:00–21:00"],
        ["FLAT", 6050, ""],
      ],
      others: [["ENERGY", 3509, "otherwise"]],
      unexplained: false,
    });
    // 21:00 in Amsterdam, then the same instant on a clock where it is 19:00 UTC.
    const night = at("2026-10-01T19:00:00Z");
    expect(night.now).toEqual([
      ["ENERGY", 3509, ""],
      ["FLAT", 6050, ""],
    ]);
    expect(night.others).toEqual([["ENERGY", 4719, "Mon–Fri, 07:00–21:00"]]);
    expect(at("2026-10-01T19:00:00Z", "UTC").now[0][1]).toBe(4719);
    // Saturday noon.
    expect(at("2026-10-03T10:00:00Z").now[0][1]).toBe(3509);
  });

  it("leaves out a kind that has no rate today, and one outside its dates", () => {
    const t = tariff([
      rate("ENERGY", 0.4),
      rate("PARKING_TIME", 2, { day_of_week: ["SATURDAY"] }),
      rate("FLAT", 1, { start_date: "2026-11-01" }),
    ]);
    expect(nowOf(t).now).toEqual([["ENERGY", 4000, ""]]);
    expect(nowOf(t).others).toEqual([
      ["PARKING_TIME", 20000, "Sat"],
      ["FLAT", 10000, "from 2026-11-01"],
    ]);
  });

  it("never prices a normal start with a reservation's rate", () => {
    const t = tariff([
      rate("TIME", 5, { reservation: "RESERVATION" }),
      rate("TIME", 1),
    ]);
    expect(nowOf(t)).toEqual({
      now: [["TIME", 10000, ""]],
      others: [["TIME", 50000, "while reserved"]],
      unexplained: false,
    });
  });

  it("shows a power tier placed before the rate for any power beside it", () => {
    // First match: a fast charge is billed €0.60, never only the €0.40.
    const t = tariff([
      rate("ENERGY", 0.6, { min_power: 50 }),
      rate("ENERGY", 0.4),
    ]);
    expect(nowOf(t)).toEqual({
      now: [["ENERGY", 4000, ""]],
      tiers: [["ENERGY", 6000, "at 50 kW or more"]],
      others: [],
      unexplained: false,
    });
    // A connector that cannot reach 50 kW settles it, one that can does not.
    expect(nowOf(t, NOON, AMSTERDAM, { maxPowerKw: 22 })).toEqual({
      now: [["ENERGY", 4000, ""]],
      others: [["ENERGY", 6000, "at 50 kW or more"]],
      unexplained: false,
    });
    expect(nowOf(t, NOON, AMSTERDAM, { maxPowerKw: 150 }).tiers).toEqual([
      ["ENERGY", 6000, "at 50 kW or more"],
    ]);
  });

  it("shows a tier below a power placed before the rate for any power", () => {
    const t = tariff([
      rate("ENERGY", 0.3, { max_power: 11 }),
      rate("ENERGY", 0.5),
    ]);
    expect(nowOf(t)).toEqual({
      now: [["ENERGY", 5000, ""]],
      tiers: [["ENERGY", 3000, "below 11 kW"]],
      others: [],
      unexplained: false,
    });
    // At a 7.4 kW connector every session is below 11 kW: the tier is what applies.
    expect(nowOf(t, NOON, AMSTERDAM, { maxPowerKw: 7.4 })).toEqual({
      now: [["ENERGY", 3000, "below 11 kW"]],
      others: [["ENERGY", 5000, "otherwise"]],
      unexplained: false,
    });
    // At 50 kW a car may still charge below 11 kW.
    expect(nowOf(t, NOON, AMSTERDAM, { maxPowerKw: 50 }).tiers).toEqual([
      ["ENERGY", 3000, "below 11 kW"],
    ]);
  });

  it("judges current tiers by the connector's amperage", () => {
    const t = tariff([rate("TIME", 2, { min_current: 32 }), rate("TIME", 1)]);
    expect(nowOf(t).tiers).toEqual([["TIME", 20000, "at 32 A or more"]]);
    expect(nowOf(t, NOON, AMSTERDAM, { maxCurrentA: 16 })).toEqual({
      now: [["TIME", 10000, ""]],
      others: [["TIME", 20000, "at 32 A or more"]],
      unexplained: false,
    });
  });

  it("lists a power tier placed after the rate for any power as another rate", () => {
    // First match: the €0.40 always applies first, so the tier never does.
    const t = tariff([
      rate("ENERGY", 0.4),
      rate("ENERGY", 0.6, { min_power: 50 }),
    ]);
    expect(nowOf(t)).toEqual({
      now: [["ENERGY", 4000, ""]],
      others: [["ENERGY", 6000, "at 50 kW or more"]],
      unexplained: false,
    });
  });

  it("with only tiers, shows the first with its condition and the rest beside it", () => {
    const t = tariff([
      rate("ENERGY", 0.4, { max_power: 50 }),
      rate("ENERGY", 0.6, { min_power: 50 }),
    ]);
    expect(nowOf(t)).toEqual({
      now: [["ENERGY", 4000, "below 50 kW"]],
      tiers: [["ENERGY", 6000, "at 50 kW or more"]],
      others: [],
      unexplained: false,
    });
    expect(nowOf(t, NOON, AMSTERDAM, { maxPowerKw: 22 })).toEqual({
      now: [["ENERGY", 4000, "below 50 kW"]],
      others: [["ENERGY", 6000, "at 50 kW or more"]],
      unexplained: false,
    });
  });

  describe("across midnight", () => {
    // A night rate from 22:00 to 06:00, the day rate otherwise.
    const t = tariff([
      rate("ENERGY", 0.2, { start_time: "22:00", end_time: "06:00" }),
      rate("ENERGY", 0.5),
    ]);
    const night = [["ENERGY", 2000, "22:00–06:00"]];
    const day = [["ENERGY", 5000, ""]];
    // Los Angeles is UTC−8 on these dates: 23:30 local is the next day in UTC.
    // Tokyo is UTC+9: 05:59 local is the day before in UTC.
    it.each([
      ["America/Los_Angeles", "2026-11-26T07:30:00Z", "23:30", night],
      ["America/Los_Angeles", "2026-11-26T13:59:00Z", "05:59", night],
      ["America/Los_Angeles", "2026-11-26T14:00:00Z", "06:00", day],
      ["Asia/Tokyo", "2026-11-25T14:30:00Z", "23:30", night],
      ["Asia/Tokyo", "2026-11-25T20:59:00Z", "05:59", night],
      ["Asia/Tokyo", "2026-11-25T21:00:00Z", "06:00", day],
    ])("%s at %s UTC (%s local)", (zone, iso, _local, expected) => {
      expect(nowOf(t, new Date(iso), zone).now).toEqual(expected);
    });

    it("takes the weekday and date from the local clock, not UTC", () => {
      // Friday 23:30 in Los Angeles is Saturday 07:30 UTC.
      const at = new Date("2026-11-28T07:30:00Z");
      const friday = tariff([
        rate("TIME", 1, {
          day_of_week: ["FRIDAY"],
          start_time: "22:00",
          end_time: "06:00",
        }),
        rate("TIME", 3, { end_date: "2026-11-28" }),
        rate("TIME", 2),
      ]);
      expect(nowOf(friday, at, "America/Los_Angeles").now).toEqual([
        ["TIME", 10000, "Fri, 22:00–06:00"],
      ]);
      expect(nowOf(friday, at, "UTC").now).toEqual([["TIME", 20000, ""]]);
      // 06:00 local ends the window.
      expect(
        nowOf(friday, new Date("2026-11-27T14:00:00Z"), "America/Los_Angeles")
          .now,
      ).toEqual([["TIME", 30000, "before 2026-11-28"]]);
    });
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
        unitPriceE4: 5900,
        amountExclVatMinor: 1770,
        vat: 21,
      },
      {
        type: "TIME",
        quantity: 0.25,
        unitPriceE4: 60000,
        amountExclVatMinor: 150,
        vat: 21,
      },
    ]);
    expect(p).toMatchObject({
      currency: "EUR",
      minorDigits: 2,
      totalExclVatMinor: 1920,
      totalInclVatMinor: 2323,
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
    expect(
      weekday.lines.map((l) => [l.type, l.unitPriceE4, l.quantity]),
    ).toEqual([
      ["FLAT", 5000, 1],
      ["ENERGY", 3900, 5.5],
      ["ENERGY", 2900, 5.5],
    ]);
    expect(weekday.totalExclVatMinor).toBe(424);
    expect(weekday.totalInclVatMinor).toBe(513);

    const saturday = previewCost(SAMPLE.AC_DAY_NIGHT, {
      start: new Date("2026-10-24T10:00:00Z"),
      energyKwh: 10,
      chargingMinutes: 60,
      timeZone: AMSTERDAM,
    });
    expect(saturday.totalExclVatMinor).toBe(340);
    // In UTC the same instant is still a weekday evening at 18:30: day rate first.
    const utc = previewCost(SAMPLE.AC_DAY_NIGHT, {
      start: new Date("2026-10-21T18:30:00Z"),
      energyKwh: 11,
      chargingMinutes: 60,
    });
    expect(utc.lines.find((l) => l.unitPriceE4 === 3900)?.quantity).toBe(11);
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
      amountExclVatMinor: 217,
    });
    expect(p.totalExclVatMinor).toBe(567);
    expect(p.totalInclVatMinor).toBe(686);
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
    expect(t.lines.map((l) => [l.unitPriceE4, l.quantity])).toEqual([
      [3000, 10],
      [2000, 10],
    ]);
    expect(t.totalExclVatMinor).toBe(500);
    // No VAT rate given: no total with VAT.
    expect(t.totalInclVatMinor).toBeNull();
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
        .totalExclVatMinor,
    ).toBe(2500);
    expect(
      previewCost(bands, { start, energyKwh: 11, chargingMinutes: 60 })
        .totalExclVatMinor,
    ).toBe(330);
  });

  it("applies min_price and max_price to the total", () => {
    const min = previewCost(SAMPLE.HPC, {
      start: new Date("2026-10-21T10:00:00Z"),
      energyKwh: 1,
      chargingMinutes: 2,
    });
    expect(min).toMatchObject({
      bounded: "min",
      totalExclVatMinor: 100,
      totalInclVatMinor: 121,
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
      totalExclVatMinor: 1500,
      totalInclVatMinor: null,
    });
  });

  it("previews a free tariff as free, and an empty session as only the flat fee", () => {
    const free = previewCost(SAMPLE.FREE, {
      start: new Date("2026-10-21T10:00:00Z"),
      energyKwh: 7,
      chargingMinutes: 60,
    });
    expect(free).toMatchObject({
      totalExclVatMinor: 0,
      totalInclVatMinor: 0,
      text: "€0.00",
    });
    const flat = previewCost(SAMPLE.AC_DAY_NIGHT, {
      start: new Date("2026-10-21T10:00:00Z"),
      energyKwh: 0,
      chargingMinutes: 0,
    });
    expect(flat.totalExclVatMinor).toBe(50);
  });

  it("reads an unknown time zone as UTC", () => {
    const p = previewCost(SAMPLE.AC_DAY_NIGHT, {
      start: new Date("2026-10-21T18:30:00Z"),
      energyKwh: 11,
      chargingMinutes: 60,
      timeZone: "Not/AZone",
    });
    expect(p.lines.find((l) => l.unitPriceE4 === 3900)?.quantity).toBe(11);
  });

  it("computes in integers and rounds the total once, half up", () => {
    const start = new Date("2026-10-21T10:00:00Z");
    // 1.005 * 100 is 100.49999... in floating point; in integers it is 100.5 cents.
    const flat = tariff([
      { price_components: [{ type: "FLAT", price: 1.005, step_size: 1 }] },
    ]);
    expect(
      previewCost(flat, { start, energyKwh: 0, chargingMinutes: 0 }),
    ).toMatchObject({ totalExclVatMinor: 101, text: "€1.01 excl. VAT" });

    // Three lines of half a cent each: each shows 1 cent, the total is 1.5 cents → 2.
    const half = tariff([
      {
        price_components: [
          { type: "FLAT", price: 0.005, step_size: 1 },
          { type: "TIME", price: 0.005, step_size: 1 },
          { type: "PARKING_TIME", price: 0.005, step_size: 1 },
        ],
      },
    ]);
    const p = previewCost(half, {
      start,
      energyKwh: 1,
      chargingMinutes: 60,
      parkingMinutes: 60,
    });
    expect(p.lines.map((l) => l.amountExclVatMinor)).toEqual([1, 1, 1]);
    expect(p.totalExclVatMinor).toBe(2);
    for (const n of [
      p.totalExclVatMinor,
      ...p.lines.map((l) => l.amountExclVatMinor),
    ])
      expect(Number.isInteger(n)).toBe(true);

    // VAT applied to the exact amount: 0.3333 * 3 kWh = 0.9999, * 1.21 = 1.209879.
    const vat = tariff([
      {
        price_components: [
          { type: "ENERGY", price: 0.3333, vat: 21, step_size: 1 },
        ],
      },
    ]);
    expect(
      previewCost(vat, { start, energyKwh: 3, chargingMinutes: 30 }),
    ).toMatchObject({ totalExclVatMinor: 100, totalInclVatMinor: 121 });
  });

  it("uses the currency's own minor unit", () => {
    const yen = tariff(
      [{ price_components: [{ type: "ENERGY", price: 35.5, step_size: 1 }] }],
      { currency: "JPY" },
    );
    const p = previewCost(yen, {
      start: new Date("2026-10-21T10:00:00Z"),
      energyKwh: 7.3,
      chargingMinutes: 60,
    });
    expect(p).toMatchObject({
      minorDigits: 0,
      totalExclVatMinor: 259,
      text: "¥259 excl. VAT",
    });
    expect(displayPrice(yen).components[0]).toMatchObject({
      priceE4: 355_000,
      text: "¥35.5 per kWh excl. VAT",
    });
  });
});
