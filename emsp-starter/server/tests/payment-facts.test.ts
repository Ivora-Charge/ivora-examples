import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaymentFacts } from "@/app/admin/payments/payment-facts";
import type { PaymentSummary } from "@/app/admin/payments/actions";

const payment = (currency: string): PaymentSummary => ({
  id: "pay_1",
  commandId: "cmd_1",
  driverRef: "driver-1",
  status: "captured",
  currency,
  holdAmount: 2500,
  authorizedAmount: 2500,
  capturedAmount: 2321,
  refundedAmount: 500,
  cdrAmount: 2321,
  cdrCurrency: currency,
  review: null,
  shortfallAmount: 179,
  reviewedAt: null,
  stopReason: null,
  error: "",
  createdAt: "2026-10-27T12:00:00Z",
  refunds: [
    {
      id: "re_1",
      amount: 500,
      status: "succeeded",
      reason: "",
      actor: "admin",
      createdAt: "2026-10-27T13:00:00Z",
    },
  ],
});

const render = (p: PaymentSummary) =>
  renderToStaticMarkup(createElement(PaymentFacts, { p })).replace(/ /g, " ");

/** The text of each fact, by its label. */
const facts = (html: string) =>
  Object.fromEntries(
    [...html.matchAll(/<dt>([^<]+)<\/dt><dd>([^<]*)<\/dd>/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );

describe("payment facts in the admin web", () => {
  it("shows a CAD payment in dollars and cents", () => {
    const html = render(payment("CAD"));
    expect(facts(html)).toMatchObject({
      Hold: "CA$25.00",
      Authorised: "CA$25.00",
      Captured: "CA$23.21",
      Refunded: "CA$5.00",
      "CDR total": "CA$23.21",
      "Not charged": "CA$1.79",
    });
    expect(html).toContain("Refund CA$5.00: succeeded");
  });

  it("shows a JPY payment with no decimals", () => {
    const html = render(payment("JPY"));
    expect(facts(html)).toMatchObject({
      Hold: "¥2,500",
      Authorised: "¥2,500",
      Captured: "¥2,321",
      Refunded: "¥500",
      "CDR total": "¥2,321",
      "Not charged": "¥179",
    });
    expect(html).toContain("Refund ¥500: succeeded");
  });

  it("leaves no bare minor-unit number", () => {
    const money = [
      "Hold",
      "Authorised",
      "Captured",
      "Refunded",
      "CDR total",
      "Not charged",
    ];
    for (const [currency, symbol] of [
      ["CAD", "CA$"],
      ["JPY", "¥"],
    ]) {
      const html = render(payment(currency));
      const shown = facts(html);
      for (const k of money) expect(shown[k].startsWith(symbol)).toBe(true);
      expect(html).toContain(`Refund ${symbol}`);
    }
    // CAD cents never appear as a plain number.
    expect(render(payment("CAD"))).not.toMatch(/\b(2500|2321|179)\b/);
  });
});
