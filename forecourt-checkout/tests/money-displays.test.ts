import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { headline, Prepay, SaleSummary } from "@/components/cashier-console";
import { CounterStatus } from "@/components/counter-screen";
import { StoreReceipt } from "@/components/store-receipt";
import { majorToMinor } from "@/lib/money";
import { receiptEmail, receiptLines } from "@/lib/receipt-email";
import {
  driverSale,
  paidReport,
  validateTerms,
  type SaleView,
  type Tile,
} from "@/lib/store";

// Every in-store money display, fed a CAD sale. The CAD demo charger has no
// cashier console, so these use fixtures. A "$" not preceded by "CA" would be
// a hard-coded US dollar sign.

const BARE_DOLLAR = /(?<!CA)\$/;

const base = {
  demo: false,
  charger: { code: "SITE-7", label: "Pump 7", name: "Toronto", connector: 1 },
  phase: "done",
  currency: "CAD",
  energyWh: 35_000,
  powerW: 0,
  startedAt: "2026-10-20T15:00:00Z",
  endedAt: "2026-10-20T15:40:00Z",
  stopping: false,
  stopProblem: null,
  limitReached: null,
  canStop: false,
  speed: 1,
  message: null,
  error: null,
} as const;

const bill = {
  rows: [
    { label: "Energy", detail: "35 kWh at CA$0.52/kWh", amountCents: 1820 },
    { label: "Idle fee", detail: "12 min at CA$0.50/min", amountCents: 600 },
  ],
  currency: "CAD",
  billTotalCents: 2420,
  graceCreditCents: 480,
  dueCents: 1940,
  idleSeconds: 720,
  graceMinutes: 10,
};

/** Pay after charging: CA$19.40 still due at the counter. */
const postpay: SaleView = {
  ...base,
  sale: "post-3fa9c01b77de",
  terms: { mode: "postpay", prepaidCents: null, limitWh: null },
  runningCents: 2420,
  bill,
  amounts: {
    dueCents: 1940,
    prepaidCents: 0,
    coveredCents: 0,
    changeCents: 0,
    changeGiven: false,
    overrunCents: 0,
    collectedCents: 0,
    outstandingCents: 1940,
    prepaidRecorded: true,
    payments: [],
    settledAt: null,
    status: "due",
  },
};

/** Prepaid CA$30.00, cost CA$19.40, CA$10.60 change handed back. */
const prepay: SaleView = {
  ...base,
  sale: "pre-3000-0-3fa9c01b77de",
  terms: { mode: "prepay", prepaidCents: 3000, limitWh: null },
  runningCents: 2420,
  bill,
  amounts: {
    dueCents: 1940,
    prepaidCents: 3000,
    coveredCents: 1940,
    changeCents: 1060,
    changeGiven: true,
    overrunCents: 0,
    collectedCents: 0,
    outstandingCents: 0,
    prepaidRecorded: true,
    payments: [
      { step: "prepaid", method: null, posReference: null, amountCents: 3000 },
    ],
    settledAt: null,
    status: "paid",
  },
};

/** Prepaid CA$15.00, cost CA$19.40: CA$4.40 extra due. */
const overrun: SaleView = {
  ...prepay,
  sale: "pre-1500-0-3fa9c01b77de",
  terms: { mode: "prepay", prepaidCents: 1500, limitWh: null },
  amounts: {
    ...prepay.amounts!,
    prepaidCents: 1500,
    coveredCents: 1500,
    changeCents: 0,
    changeGiven: false,
    overrunCents: 440,
    outstandingCents: 440,
    status: "due",
  },
};

const tile = (over: Partial<Tile>): Tile => ({
  key: "SITE-7|1",
  code: "SITE-7",
  label: "Pump 7",
  stationName: "Toronto",
  connector: 1,
  connectorLabel: "CCS",
  status: "Available",
  online: true,
  state: "available",
  sale: null,
  warning: null,
  canPrepay: true,
  canPostpay: false,
  currency: "CAD",
  ...over,
});

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element);

describe("receipt email in CAD", () => {
  const site = { siteName: "Forecourt", timeZone: "America/Toronto" };

  it("lists every amount in CA$", () => {
    expect(receiptLines(postpay, site.timeZone).slice(3)).toEqual([
      ["Energy", "35.00 kWh"],
      ["Energy", "CA$18.20"],
      ["Idle fee", "CA$6.00"],
      ["Idle grace", "-CA$4.80"],
      ["Total", "CA$19.40"],
      ["Still due", "CA$19.40"],
    ]);
    expect(receiptLines(prepay, site.timeZone).slice(-3)).toEqual([
      ["Total", "CA$19.40"],
      ["Prepaid", "CA$30.00"],
      ["Change given", "CA$10.60"],
    ]);
  });

  it("has no bare $ in the text or HTML", () => {
    for (const view of [postpay, prepay, overrun]) {
      const email = receiptEmail(view, "driver@example.com", site);
      expect(email.text).toContain("Total: CA$19.40");
      expect(email.html).toContain("CA$19.40");
      expect(email.text).not.toMatch(BARE_DOLLAR);
      expect(email.html).not.toMatch(BARE_DOLLAR);
    }
  });
});

describe("store receipt and sale summary in CAD", () => {
  it("StoreReceipt", () => {
    const out = html(
      createElement(StoreReceipt, {
        view: prepay,
        siteName: "Forecourt",
        timeZone: "America/Toronto",
      }),
    );
    for (const amount of ["CA$18.20", "−CA$4.80", "CA$19.40", "CA$30.00"])
      expect(out).toContain(amount);
    expect(out).toContain("CA$10.60");
    expect(out).not.toMatch(BARE_DOLLAR);
  });

  it("SaleSummary", () => {
    const due = html(createElement(SaleSummary, { view: postpay }));
    expect(due).toContain("CA$24.20");
    expect(due).toContain("Amount due: <strong>CA$19.40</strong>");
    const extra = html(createElement(SaleSummary, { view: overrun }));
    expect(extra).toContain("Used CA$4.40 more than prepaid.");
    expect(extra).toContain("Extra due CA$4.40");
    for (const out of [
      due,
      extra,
      html(createElement(SaleSummary, { view: prepay })),
    ])
      expect(out).not.toMatch(BARE_DOLLAR);
  });
});

describe("counter screen and cashier headline in CAD", () => {
  const counter = (view: SaleView) =>
    html(
      createElement(CounterStatus, {
        code: "SITE-7",
        connector: 1,
        label: "Pump 7",
        error: null,
        state: {
          demo: false,
          code: "SITE-7",
          label: "Pump 7",
          name: "Toronto",
          connector: 1,
          status: "Finishing",
          online: true,
          sale: driverSale(view),
          graceMinutes: 10,
          pollMs: 2000,
        },
      }),
    );

  it("the driver's counter screen", () => {
    const due = counter(postpay);
    expect(due).toContain("total CA$19.40");
    expect(due).toContain("Pay <strong>CA$19.40</strong> at the counter.");
    const charging = counter({
      ...prepay,
      phase: "charging",
      amounts: null,
      runningCents: 1234,
    });
    expect(charging).toContain("CA$12.34");
    expect(charging).toContain("of CA$30.00 prepaid");
    for (const out of [due, charging, counter(overrun)])
      expect(out).not.toMatch(BARE_DOLLAR);
  });

  it("the tile headline", () => {
    expect(headline(tile({ state: "done_unpaid", sale: postpay }))).toBe(
      "Due CA$19.40",
    );
    expect(headline(tile({ state: "done_unpaid", sale: overrun }))).toBe(
      "Extra due CA$4.40",
    );
    expect(headline(tile({ state: "paid", sale: prepay }))).toBe(
      "CA$19.40 paid",
    );
    expect(
      headline(
        tile({
          state: "charging",
          sale: { ...prepay, phase: "charging", energyWh: 12_500 },
        }),
      ),
    ).toBe("12.50 kWh · CA$24.20");
  });
});

describe("prepay in the tile's currency", () => {
  const prepayForm = (currency: string) =>
    html(
      createElement(Prepay, {
        tile: tile({ currency }),
        refresh: async () => {},
      }),
    );

  it("labels the field and the quick amounts with the currency", () => {
    const out = prepayForm("CAD");
    expect(out).toContain("Prepaid amount (CAD)");
    expect(out).toContain("CA$10.00");
    expect(out).toContain("CA$50.00");
    expect(out).not.toMatch(BARE_DOLLAR);
    expect(prepayForm("JPY")).toContain("Prepaid amount (JPY)");
  });

  it("parses what the cashier types with the currency's exponent", () => {
    expect(majorToMinor("20", "CAD")).toBe(2000);
    expect(majorToMinor("12.5", "CAD")).toBe(1250);
    expect(majorToMinor("CA$12.55", "CAD")).toBe(1255);
    expect(majorToMinor("12.555", "CAD")).toBeNull();
    expect(majorToMinor("1500", "JPY")).toBe(1500);
    expect(majorToMinor("1.5", "JPY")).toBeNull();
  });
});

describe("cashier messages name amounts in the sale's currency", () => {
  const terms = { mode: "prepay", prepaidCents: 50, limitWh: null } as const;

  it("the prepaid bounds", () => {
    expect(validateTerms(terms, "CAD")).toBe(
      "The prepaid amount must be between CA$1.00 and CA$500.00.",
    );
    // No currency known: the documented USD default.
    expect(validateTerms(terms)).toBe(
      "The prepaid amount must be between $1.00 and $500.00.",
    );
  });

  it("the amount due on a mark-paid mismatch", () => {
    const rule = paidReport(
      postpay.sale,
      postpay.terms,
      postpay.amounts!,
      { amountCents: 100, method: "cash", posReference: null },
      "CAD",
    );
    expect(rule).toEqual({
      ok: false,
      code: "amount_mismatch",
      message: "The amount due on the final bill is CA$19.40.",
    });
  });
});
