import "server-only";
import { divRound, formatUnits, toE4 } from "@/lib/locations/pricing";
import type { Amount } from "@/lib/ocpi/session-objects";

/** Digits after the decimal point of a currency's minor unit: 2 for EUR, 0 for JPY. */
export function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits!;
  } catch {
    return 2;
  }
}

/**
 * An OCPI amount (a decimal of the major unit, at most 4 decimals) in whole minor units,
 * rounded once, half up: 12.345 EUR is 1235, 12.3449 EUR is 1234.
 */
export function toMinor(amount: number, currency: string): number {
  const digits = minorDigits(currency);
  return Number(divRound(toE4(amount), 10n ** BigInt(4 - digits)));
}

/** Minor units, formatted for a person: 1235 EUR is "€12.35". */
export function formatMinor(minor: number, currency: string): string {
  return formatUnits(BigInt(minor), minorDigits(currency), currency);
}

/**
 * What a CDR asks the driver to pay, in minor units: its total cost including VAT,
 * rounded once. `vatKnown` is false when the CPO gave no amount including VAT; the
 * amount excluding VAT is used then, so the driver is never charged more than the CPO
 * billed, and the payment goes to admin review.
 */
export function cdrAmount(
  total: Amount,
  currency: string,
): { minor: number; vatKnown: boolean } {
  const vatKnown = total.incl_vat !== undefined;
  const minor = toMinor(vatKnown ? total.incl_vat! : total.excl_vat, currency);
  return { minor: Math.max(0, minor), vatKnown };
}
