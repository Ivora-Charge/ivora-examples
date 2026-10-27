import { formatMinor, mixedCurrenciesNote } from "@/lib/money";
import type { RevenueLine } from "../ivora/types";
import type { CurrencyTotals, ReportTotals } from "./types";

// The Reports page's money figures as text: one amount per currency, joined with " · "
// and never added together, with a "Mixed currencies" note when there is more than one.

/** A figure's value and its note (undefined for none). */
export interface MoneyFigure {
  value: string;
  note: string | undefined;
}

const join = (parts: (string | undefined)[]) =>
  parts.filter(Boolean).join(". ") || undefined;

/** Ivora's billed revenue (final bills), or that billing:read is missing (null). */
export function revenueText(lines: RevenueLine[] | null): string {
  if (lines === null) return "Needs billing:read";
  if (!lines.length) return "None";
  return lines.map((l) => formatMinor(l.billed_minor, l.currency)).join(" · ");
}

/** The "Billed (final bills)" figure of Ivora's stats. */
export function billedFigure(
  revenue: { currencies: RevenueLine[] } | null,
): MoneyFigure {
  return {
    value: revenueText(revenue?.currencies ?? null),
    note: revenue
      ? join([
          `${revenue.currencies.reduce((n, l) => n + l.bills, 0)} final bills`,
          mixedCurrenciesNote(revenue.currencies.map((l) => l.currency)),
        ])
      : undefined,
  };
}

function moneyText(
  lines: readonly CurrencyTotals[],
  pick: (l: CurrencyTotals) => number,
): string {
  return lines.length
    ? lines.map((l) => formatMinor(pick(l), l.currency)).join(" · ")
    : "None";
}

/** The money figures of the kit's own checkouts. */
export function totalsFigures(t: ReportTotals): {
  collected: MoneyFigure;
  refunded: MoneyFigure;
  billed: MoneyFigure;
} {
  const mixed = mixedCurrenciesNote(t.currencies.map((l) => l.currency));
  return {
    collected: {
      value: moneyText(t.currencies, (l) => l.capturedMinor - l.refundedMinor),
      note: join([`${t.byStatus.charged} charged`, mixed]),
    },
    refunded: {
      value: moneyText(t.currencies, (l) => l.refundedMinor),
      note: mixed,
    },
    billed: {
      value: moneyText(t.currencies, (l) => l.billedMinor),
      note: mixed,
    },
  };
}
