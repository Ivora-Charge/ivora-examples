import { describe, expect, it } from "vitest";
import { DEMO_TARIFF } from "@/lib/demo";
import {
  elementsFromPrices,
  formFromTariff,
  localQuote,
  parkingLines,
  priceBreakdown,
  priceLines,
  quoteRows,
  type Quote,
  type Tariff,
} from "@/lib/tariff";

// Shaped like POST /v1/tenants/{tenant_id}/tariffs/{tariff_id}/quote output.
const apiQuote: Quote = {
  currency: "USD",
  pricing_version: "elements-v1",
  lines: [
    {
      type: "ENERGY",
      element: 0,
      reservation: false,
      quantity: "30.000000",
      unit: "kWh",
      price_minor: "45",
      exact_minor: "1350.000000",
      amount_minor: 1350,
    },
    {
      type: "TIME",
      element: 0,
      reservation: false,
      quantity: "0.416667",
      unit: "h",
      price_minor: "360",
      exact_minor: "150.000000",
      amount_minor: 150,
    },
    {
      type: "PARKING_TIME",
      element: 0,
      reservation: false,
      quantity: "0.250000",
      unit: "h",
      price_minor: "2400",
      exact_minor: "600.000000",
      amount_minor: 600,
    },
    {
      type: "FLAT",
      element: 0,
      reservation: false,
      quantity: "1",
      unit: "session",
      price_minor: "100",
      exact_minor: "100.000000",
      amount_minor: 100,
    },
  ],
  subtotal_minor: 2200,
  exact_subtotal_minor: "2200.000000",
  adjustments: [
    {
      kind: "group_discount",
      rule: "staff",
      exact_minor: "-220.000000",
      amount_minor: -220,
    },
  ],
  total_minor: 1980,
};

describe("quote display", () => {
  it("labels each line with its quantity, rate and API-rounded amount", () => {
    expect(quoteRows(apiQuote)).toEqual([
      { label: "Energy", detail: "30.00 kWh × $0.45/kWh", amountCents: 1350 },
      { label: "Charging time", detail: "25 min × $3.60/h", amountCents: 150 },
      { label: "Idle fee", detail: "15 min × $24.00/h", amountCents: 600 },
      { label: "Session fee", detail: "per session", amountCents: 100 },
      { label: "Discount", detail: "staff", amountCents: -220 },
    ]);
  });

  it("keeps sub-cent rates visible", () => {
    const q: Quote = {
      ...apiQuote,
      lines: [{ ...apiQuote.lines[0], price_minor: "35.49" }],
      adjustments: [],
    };
    expect(quoteRows(q)[0].detail).toBe("30.00 kWh × $0.3549/kWh");
  });

  it("picks out idle lines for the grace credit", () => {
    expect(parkingLines(apiQuote)).toEqual([
      { exactMinor: "600.000000", priceMinorPerHour: "2400" },
    ]);
    expect(parkingLines(null)).toEqual([]);
  });
});

describe("price breakdown", () => {
  it("reads energy, time, idle and session prices from the elements", () => {
    const b = priceBreakdown(DEMO_TARIFF);
    expect(b).toMatchObject({
      energyPerKwh: 4500,
      timePerHour: 36000,
      idlePerHour: 240000,
      sessionFee: 10000,
      idleStepSeconds: 60,
      conditional: false,
    });
    expect(priceLines(b)).toEqual([
      { label: "Energy", value: "$0.45 per kWh" },
      { label: "Charging time", value: "$0.06 per minute" },
      { label: "Idle fee", value: "$0.40 per minute" },
      { label: "Session fee", value: "$1.00" },
    ]);
  });

  it("treats a simple tariff as one energy price", () => {
    const simple: Tariff = {
      id: 1,
      currency: "USD",
      rate_minor_per_kwh: 35,
      authorization_minor: 0,
      elements: null,
    };
    expect(priceLines(priceBreakdown(simple))).toEqual([
      { label: "Energy", value: "$0.35 per kWh" },
    ]);
  });

  it("flags conditional prices and refuses to edit them in the simple form", () => {
    const peak: Tariff = {
      ...DEMO_TARIFF,
      elements: [
        {
          price_components: [{ type: "ENERGY", price: 0.6 }],
          restrictions: { start_time: "16:00", end_time: "21:00" },
        },
        { price_components: [{ type: "ENERGY", price: 0.4 }] },
      ],
    };
    expect(priceBreakdown(peak)).toMatchObject({
      energyPerKwh: 4000,
      conditional: true,
    });
    expect(formFromTariff(peak)).toBeNull();
  });
});

describe("operator price form", () => {
  const form = {
    energyCentsPerKwh: 45,
    timeCentsPerMinute: 6,
    idleCentsPerMinute: 40,
    sessionFeeCents: 100,
    holdCents: 5000,
  };

  it("builds one unrestricted element priced per minute for time and idle", () => {
    expect(elementsFromPrices(form, "USD")).toEqual([
      {
        price_components: [
          { type: "ENERGY", price: 0.45, step_size: 1 },
          { type: "TIME", price: 3.6, step_size: 60 },
          { type: "PARKING_TIME", price: 24, step_size: 60 },
          { type: "FLAT", price: 1 },
        ],
      },
    ]);
  });

  it("round-trips through the tariff", () => {
    const tariff: Tariff = {
      ...DEMO_TARIFF,
      elements: elementsFromPrices(form, "USD"),
    };
    expect(formFromTariff(tariff)).toEqual(form);
  });

  it("omits zero-priced dimensions and rejects bad input", () => {
    expect(
      elementsFromPrices(
        {
          ...form,
          timeCentsPerMinute: 0,
          idleCentsPerMinute: 0,
          sessionFeeCents: 0,
        },
        "USD",
      )[0].price_components,
    ).toHaveLength(1);
    expect(() =>
      elementsFromPrices({ ...form, energyCentsPerKwh: 4.5 }, "USD"),
    ).toThrow();
    expect(() =>
      elementsFromPrices({ ...form, sessionFeeCents: -1 }, "USD"),
    ).toThrow();
  });
});

describe("local quote (demo pricing)", () => {
  it("prices the typical session the charger page shows", () => {
    const q = localQuote(DEMO_TARIFF, {
      energyWh: 30_000,
      chargingSeconds: 25 * 60,
      idleSeconds: 0,
    });
    expect(q.lines.map((l) => [l.type, l.amount_minor])).toEqual([
      ["ENERGY", 1350],
      ["TIME", 150],
      ["FLAT", 100],
    ]);
    expect(q.total_minor).toBe(1600);
  });

  it("matches the portal's energy-v1 example: 6.941 kWh at $0.35 is 243 cents", () => {
    const simple: Tariff = {
      id: 1,
      currency: "USD",
      rate_minor_per_kwh: 35,
      authorization_minor: 0,
    };
    expect(
      localQuote(simple, { energyWh: 6941, chargingSeconds: 0, idleSeconds: 0 })
        .total_minor,
    ).toBe(243);
  });

  it("rounds time up to whole steps and the total half up once", () => {
    const q = localQuote(DEMO_TARIFF, {
      energyWh: 1001,
      chargingSeconds: 61,
      idleSeconds: 1,
    });
    const time = q.lines.find((l) => l.type === "TIME")!;
    const idle = q.lines.find((l) => l.type === "PARKING_TIME")!;
    expect(time.quantity).toBe((120 / 3600).toFixed(6)); // 2 started minutes
    expect(idle.amount_minor).toBe(40); // 1 started minute at $24/h
    // 45.045 + 12 + 40 + 100 = 197.045 -> 197
    expect(q.total_minor).toBe(197);
    expect(q.exact_subtotal_minor).toBe("197.045000");
  });

  it("bills no time below 1 Wh", () => {
    const q = localQuote(DEMO_TARIFF, {
      energyWh: 0,
      chargingSeconds: 600,
      idleSeconds: 600,
    });
    expect(q.lines.map((l) => l.type)).toEqual(["ENERGY", "FLAT"]);
  });
});
