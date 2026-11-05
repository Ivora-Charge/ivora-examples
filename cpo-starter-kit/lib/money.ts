// Money is integer minor units (cents) with an ISO 4217 currency. These helpers parse
// what staff type and format amounts for display; they never do price arithmetic
// (Ivora prices sessions, see lib/server/pricing).

/** Locale of every amount the kit shows (the app is English only): "CA$13.50" for CAD. */
export const DISPLAY_LOCALE = "en-US";

/** Used only when an API response or a stored record carries no currency. */
export const DEFAULT_CURRENCY = "USD";

let warnedDefault = false;
/**
 * The currency of an API response or record, or the documented default (USD) when it
 * carries none. The fallback is logged once per process, never per amount.
 */
export function currencyOr(currency: string | null | undefined): string {
  if (currency) return currency;
  if (!warnedDefault) {
    warnedDefault = true;
    console.warn(
      `cpo-starter-kit: no currency in the response, assuming ${DEFAULT_CURRENCY}`,
    );
  }
  return DEFAULT_CURRENCY;
}

/**
 * A note for a figure that is shown per currency, or undefined when there is one
 * currency at most: amounts in different currencies are never added together.
 */
export function mixedCurrenciesNote(
  currencies: readonly string[],
): string | undefined {
  const codes = [...new Set(currencies)].sort();
  return codes.length > 1
    ? `Mixed currencies (${codes.join(", ")}): one amount per currency, never added together`
    : undefined;
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

/**
 * "0.35" (major units, as staff type it) to 35 minor units, or null when it is not a
 * plain non-negative amount with at most the currency's decimals. String parsing only:
 * no floating point.
 */
export function parseMajor(text: string, currency: string): number | null {
  const exp = currencyExponent(currency);
  // A leading currency symbol ("$0.35") is fine; a sign is not.
  const t = text.trim().replace(/^[^\d.+-]+/, "");
  const m = /^(\d{1,7})(?:\.(\d*))?$/.exec(t);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > exp) return null;
  return Number(m[1]) * 10 ** exp + Number(frac.padEnd(exp, "0") || "0");
}

/** 35 minor units to "0.35": the major amount as a decimal string, exactly. */
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

/** Integer minor units for display, for example "$13.50" (or "CA$13.50" for CAD). */
export function formatMinor(
  minor: number,
  currency: string,
  locale: string = DISPLAY_LOCALE,
): string {
  return formatMajorString(
    minorToMajorString(minor, currency),
    currency,
    locale,
  );
}

/**
 * A decimal string of minor units, as the API returns unit prices ("35", "0.6667"),
 * for display in major units with up to 4 extra decimals: "$0.35", "$0.006667".
 */
export function formatMinorDecimal(
  decimal: string,
  currency: string,
  locale: string = DISPLAY_LOCALE,
): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!m) return `${decimal} ${currency}`;
  const exp = currencyExponent(currency);
  const whole = m[2].padStart(exp + 1, "0");
  const frac = (m[3] ?? "").replace(/0+$/, "");
  const major =
    exp === 0
      ? `${whole}${frac ? `.${frac}` : ""}`
      : `${whole.slice(0, -exp)}.${whole.slice(-exp)}${frac}`;
  return formatMajorString(`${m[1]}${major}`, currency, locale);
}

function formatMajorString(
  major: string,
  currency: string,
  locale: string,
): string {
  const decimals = major.split(".")[1]?.length ?? 0;
  const exp = currencyExponent(currency);
  try {
    // Intl takes the decimal string as is (no float rounding for these sizes).
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: exp,
      maximumFractionDigits: Math.min(20, Math.max(exp, decimals)),
    }).format(major as unknown as number);
  } catch {
    return `${major} ${currency}`;
  }
}
