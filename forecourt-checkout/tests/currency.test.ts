import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReceiptTable } from "@/components/receipt-table";
import {
  DEMO_START_DELAY_MS,
  DEMO_TARIFF,
  DEMO_TARIFF_CAD,
  demoView,
  startDemoSession,
} from "@/lib/demo";
import { chargerFor } from "@/lib/server/driver";
import { overview } from "@/lib/server/operator";
import { readSettings } from "@/lib/settings";
import {
  elementsFromPrices,
  formFromTariff,
  formatQuoteTotal,
  localQuote,
  priceBreakdown,
  priceLines,
  quoteRows,
  type Tariff,
} from "@/lib/tariff";
import { totalsByCurrency } from "@/lib/totals";

const T0 = Date.parse("2026-10-19T12:00:00Z");
const profile = { energyWh: 20_000, chargingSeconds: 1200, idleSeconds: 600 };
const NB = " ";

describe("tariff prices in other currencies", () => {
  it("prices lines and quotes in the tariff's currency", () => {
    const lines = priceLines(priceBreakdown(DEMO_TARIFF_CAD));
    expect(lines[0]).toEqual({ label: "Energy", value: "CA$0.52 per kWh" });
    expect(lines.map((l) => l.value).join()).not.toContain("US$");
    const quote = localQuote(DEMO_TARIFF_CAD, profile);
    expect(quote.currency).toBe("CAD");
    // 20 kWh x 0.52 + 20 min x 0.07 + 10 min x 0.50 + 1.50 = 18.30
    expect(quote.total_minor).toBe(1830);
    expect(formatQuoteTotal(quote)).toBe("CA$18.30");
    expect(quoteRows(quote)[0].detail).toContain("CA$0.52/kWh");
  });

  it("handles a 0-decimal and a 3-decimal currency", () => {
    const jpy: Tariff = {
      id: 1,
      currency: "JPY",
      rate_minor_per_kwh: 45,
      authorization_minor: 5000,
    };
    expect(priceBreakdown(jpy).energyPerKwh).toBe(4500); // hundredths of a yen
    expect(priceLines(priceBreakdown(jpy))[0].value).toBe("¥45 per kWh");
    expect(localQuote(jpy, { ...profile, idleSeconds: 0 }).total_minor).toBe(
      900,
    );
    const kwd: Tariff = { ...jpy, id: 2, currency: "KWD" };
    expect(priceLines(priceBreakdown(kwd))[0].value).toBe(
      `KWD${NB}0.045 per kWh`,
    );
    expect(localQuote(kwd, profile).total_minor).toBe(900);
  });

  it("converts the operator form with the currency's exponent", () => {
    const form = {
      energyCentsPerKwh: 52,
      timeCentsPerMinute: 7,
      idleCentsPerMinute: 50,
      sessionFeeCents: 150,
      holdCents: 5000,
    };
    const price = (currency: string) =>
      elementsFromPrices(form, currency)[0].price_components.map(
        (c) => c.price,
      );
    expect(price("CAD")).toEqual([0.52, 4.2, 30, 1.5]);
    expect(price("JPY")).toEqual([52, 420, 3000, 150]);
    expect(price("KWD")).toEqual([0.052, 0.42, 3, 0.15]);
    for (const currency of ["CAD", "JPY", "KWD"]) {
      const tariff: Tariff = {
        id: 3,
        currency,
        rate_minor_per_kwh: 0,
        authorization_minor: 5000,
        elements: elementsFromPrices(form, currency),
      };
      expect(formFromTariff(tariff)).toEqual(form);
    }
  });
});

describe("reports never mix currencies", () => {
  const row = (
    currency: string,
    captured: number,
    via: "card" | "store" = "card",
  ) => ({
    currency,
    billedCents: captured,
    capturedCents: captured,
    feeCents: via === "card" ? captured / 10 : 0,
    paidVia: via,
  });

  it("groups by currency and keeps each total apart", () => {
    const totals = totalsByCurrency(
      [row("USD", 1000), row("CAD", 2000), row("USD", 500, "store")],
      new Map([
        ["USD", 1500],
        ["CAD", 2000],
      ]),
    );
    expect(totals).toEqual([
      {
        currency: "CAD",
        billedCents: 2000,
        capturedCents: 2000,
        inStoreCents: 0,
        feeCents: 200,
      },
      {
        currency: "USD",
        billedCents: 1500,
        capturedCents: 1000,
        inStoreCents: 500,
        feeCents: 100,
      },
    ]);
  });

  it("has a billed total of null without stats and lists stats-only currencies", () => {
    expect(totalsByCurrency([row("CAD", 100)], null)[0].billedCents).toBeNull();
    expect(
      totalsByCurrency([], new Map([["EUR", 700]])).map((t) => t.currency),
    ).toEqual(["EUR"]);
  });

  it("the demo overview reports USD and CAD separately", async () => {
    const data = await overview(readSettings({ DEMO_MODE: "1" }), T0);
    expect(data.totals.map((t) => t.currency)).toEqual(["CAD", "USD"]);
    const cad = data.totals[0];
    const usd = data.totals[1];
    expect(cad.capturedCents).toBe(2037 + 1455);
    expect(usd.capturedCents + usd.inStoreCents).toBe(
      2215 + 1683 + 2041 + 802 + 1754,
    );
    for (const r of data.rows) expect(["USD", "CAD"]).toContain(r.currency);
  });
});

describe("money displays follow the response's currency", () => {
  const settings = readSettings({ DEMO_MODE: "1" });

  it("the CAD demo charger page", async () => {
    const page = await chargerFor("DEMO-11", 1, settings);
    expect(page.currency).toBe("CAD");
    expect(page.prices[0].value).toBe("CA$0.52 per kWh");
    expect(page.payInStore).toBe(false);
    const usd = await chargerFor("DEMO-1", 1, settings);
    expect(usd.currency).toBe("USD");
    expect(usd.prices[0].value).toBe("$0.45 per kWh");
  });

  it("the CAD demo session and its receipt", () => {
    const id = startDemoSession("DEMO-11", 1, T0);
    const start = T0 + DEMO_START_DELAY_MS;
    const live = demoView(id, start + 5000, {
      idleGraceMinutes: 10,
      applicationFeeBps: 1000,
    })!;
    expect(live.currency).toBe("CAD");
    const done = demoView(
      `${id}.u${(start + 20_000).toString(36)}`,
      start + 30_000,
      {
        idleGraceMinutes: 10,
        applicationFeeBps: 1000,
      },
    )!;
    expect(done.receipt!.currency).toBe("CAD");
    const html = renderToStaticMarkup(
      createElement(ReceiptTable, { receipt: done.receipt! }),
    );
    expect(html).toContain("CA$");
    expect(html).not.toMatch(/[^A]\$\d/);
  });
});

it("keeps the USD sample", () => {
  expect(DEMO_TARIFF.currency).toBe("USD");
});
