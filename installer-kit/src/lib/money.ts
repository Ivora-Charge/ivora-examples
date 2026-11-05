// Money is integer minor units with an ISO 4217 currency. These helpers convert with the
// currency's exponent (never `/ 100`) and format for display.

/** Locale of every amount the app shows (English only): "CA$13.50" for CAD. */
export const DISPLAY_LOCALE = "en-US";

/** Used only when a response or record carries no currency. */
export const DEFAULT_CURRENCY = "USD";

let warnedDefault = false;
/** The currency of a response or record, or the documented default (USD), logged once. */
export function currencyOr(currency: string | null | undefined): string {
  if (currency) return currency;
  if (!warnedDefault) {
    warnedDefault = true;
    console.warn(
      `installer-kit: no currency in the response or site, assuming ${DEFAULT_CURRENCY}`,
    );
  }
  return DEFAULT_CURRENCY;
}

/** Decimal places of a currency's minor unit: 2 for USD, 0 for JPY, 3 for KWD. */
export function currencyExponent(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** 35 minor units to "0.35": the major amount as an exact decimal string. */
export function minorToMajorString(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor))
    throw new Error("Minor units must be an integer");
  const exp = currencyExponent(currency);
  const sign = minor < 0 ? "-" : "";
  const digits = String(Math.abs(minor)).padStart(exp + 1, "0");
  return exp === 0
    ? `${sign}${digits}`
    : `${sign}${digits.slice(0, -exp)}.${digits.slice(-exp)}`;
}

/** Integer minor units for display: "$13.50", "CA$13.50", "¥1,350". */
export function formatMinor(
  minor: number,
  currency: string,
  locale: string = DISPLAY_LOCALE,
  currencyDisplay: "symbol" | "code" = "symbol",
): string {
  const major = minorToMajorString(minor, currency);
  try {
    // Intl takes the decimal string as is, so there is no float rounding.
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay,
    }).format(major as unknown as number);
  } catch {
    return `${major} ${currency}`;
  }
}

/** A per-kWh price in minor units, for display: "CA$0.22/kWh". */
export function formatPerKwh(
  minorPerKwh: number,
  currency: string,
  locale: string = DISPLAY_LOCALE,
): string {
  return `${formatMinor(minorPerKwh, currency, locale)}/kWh`;
}

/** Valid ISO 4217 code that Intl knows, upper case. */
export function isCurrencyCode(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat("en-US", { style: "currency", currency: code });
    return true;
  } catch {
    return false;
  }
}

/** Currencies offered next to the price field. */
export const PRICE_CURRENCIES = ["USD", "CAD", "EUR", "GBP", "JPY"] as const;
