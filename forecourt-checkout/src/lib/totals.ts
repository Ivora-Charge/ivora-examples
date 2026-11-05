import { resolveCurrency } from "./money";

// Reports never add amounts of different currencies: every total is per currency.

export type TotalsRow = {
  currency: string;
  billedCents: number | null;
  capturedCents: number;
  feeCents: number;
  paidVia: "card" | "store";
};

export type CurrencyTotals = {
  currency: string;
  /** Ivora's final bills; null when the stats endpoint isn't readable. */
  billedCents: number | null;
  /** Card payments captured through Stripe. */
  capturedCents: number;
  /** Recorded as paid in store. */
  inStoreCents: number;
  feeCents: number;
};

/**
 * One entry per currency, sorted by code. `billedMinor` is the stats endpoint's
 * per-currency billed figure; when it's absent the billed total is null.
 */
export function totalsByCurrency(
  rows: TotalsRow[],
  billedMinor: Map<string, number> | null,
): CurrencyTotals[] {
  const codes = new Set(rows.map((r) => resolveCurrency(r.currency)));
  for (const code of billedMinor?.keys() ?? [])
    codes.add(resolveCurrency(code));
  return [...codes].sort().map((currency) => {
    const mine = rows.filter((r) => resolveCurrency(r.currency) === currency);
    const sum = (pick: (r: TotalsRow) => number, via?: TotalsRow["paidVia"]) =>
      mine
        .filter((r) => !via || r.paidVia === via)
        .reduce((total, r) => total + pick(r), 0);
    return {
      currency,
      billedCents: billedMinor ? (billedMinor.get(currency) ?? 0) : null,
      capturedCents: sum((r) => r.capturedCents, "card"),
      inStoreCents: sum((r) => r.capturedCents, "store"),
      feeCents: sum((r) => r.feeCents),
    };
  });
}
