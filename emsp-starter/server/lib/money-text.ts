// Client-safe money display: integer minor units with an ISO 4217 currency. The minor-unit
// digits come from the currency (Intl), never a fixed 2 or `/ 100`.

/** Digits after the decimal point of a currency's minor unit: 2 for CAD, 0 for JPY, 3 for KWD. */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits!;
  } catch {
    return 2;
  }
}

/** Minor units as an exact decimal string of the major unit: 1235 CAD is "12.35". */
export function minorText(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  const abs = Math.abs(minor);
  const scale = 10 ** digits;
  const frac = digits ? String(abs % scale).padStart(digits, "0") : "";
  return `${minor < 0 ? "-" : ""}${Math.floor(abs / scale)}${frac ? `.${frac}` : ""}`;
}

/** Minor units for a person: 1235 CAD is "CA$12.35" in en, 1350 JPY is "¥1,350". */
export function formatMinorAmount(
  minor: number,
  currency: string,
  locale = "en",
): string {
  const digits = currencyDigits(currency);
  try {
    // The decimal string goes to Intl as is, so there is no float rounding.
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(minorText(minor, currency) as Intl.StringNumericLiteral);
  } catch {
    return `${minorText(minor, currency)} ${currency}`;
  }
}
