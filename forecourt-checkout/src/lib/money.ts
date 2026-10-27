// Money is integer cents (USD minor units) everywhere. Decimal strings from the
// API (exact_minor, price_minor) are parsed into scaled BigInts, never floats,
// and every rounding below is half up, once, at the documented point.

/** Stripe's minimum charge in USD. Smaller amounts are waived and the hold released. */
export const MINIMUM_CHARGE_CENTS = 50;

const BPS_DENOMINATOR = 10_000;

export function assertCents(cents: number, name = "amount"): void {
  if (!Number.isSafeInteger(cents) || cents < 0)
    throw new Error(`${name} must be a non-negative whole number of cents.`);
}

/** numerator / denominator rounded half up; both non-negative. */
export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n)
    throw new Error("roundHalfUp takes a non-negative ratio.");
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** "35.49" with scale 2 -> 3549n. Rejects signs, exponents and extra decimals. */
export function parseDecimal(value: string, scale: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`Not a non-negative decimal: ${value}`);
  const fraction = match[2] ?? "";
  if (fraction.length > scale)
    throw new Error(`More than ${scale} decimal places: ${value}`);
  return BigInt(match[1] + fraction.padEnd(scale, "0"));
}

export function parseCents(raw: string, name: string): number {
  if (!/^\d+$/.test(raw.trim()))
    throw new Error(`${name} must be a whole number of cents.`);
  const cents = Number(raw.trim());
  assertCents(cents, name);
  return cents;
}

/** Basis points: 0 to 10000 (100%). The default 1000 is 10%. */
export function parseBasisPoints(raw: string): number {
  if (!/^\d+$/.test(raw.trim()))
    throw new Error(
      "APPLICATION_FEE_BPS must be a whole number of basis points.",
    );
  const bps = Number(raw.trim());
  if (bps > BPS_DENOMINATOR)
    throw new Error("APPLICATION_FEE_BPS cannot exceed 10000 (100%).");
  return bps;
}

/** The deployer's fee on a captured amount: amount x bps / 10000, rounded half up. */
export function applicationFeeCents(amountCents: number, bps: number): number {
  assertCents(amountCents);
  if (!Number.isInteger(bps) || bps < 0 || bps > BPS_DENOMINATOR)
    throw new Error("Basis points must be between 0 and 10000.");
  return Number(
    roundHalfUp(BigInt(amountCents) * BigInt(bps), BigInt(BPS_DENOMINATOR)),
  );
}

export type ParkingLine = {
  /** Unrounded line amount in cents, decimal string (6 places). */
  exactMinor: string;
  /** Idle price in cents per hour, decimal string. */
  priceMinorPerHour: string;
};

const MICRO = 6; // exact_minor carries 6 decimal places

/**
 * Ivora bills every idle minute; the app waives the first `graceSeconds` of
 * them. The credit is the grace time at the bill's lowest idle rate, capped at
 * what the bill actually charged for idle time, rounded half up once.
 */
export function idleGraceCreditCents(input: {
  parkingLines: ParkingLine[];
  idleSeconds: number;
  graceSeconds: number;
}): number {
  const { parkingLines, idleSeconds, graceSeconds } = input;
  if (parkingLines.length === 0 || idleSeconds <= 0 || graceSeconds <= 0)
    return 0;
  const charged = parkingLines.reduce(
    (sum, line) => sum + parseDecimal(line.exactMinor, MICRO),
    0n,
  );
  const rate = parkingLines
    .map((line) => parseDecimal(line.priceMinorPerHour, MICRO))
    .reduce((low, price) => (price < low ? price : low));
  // Work in micro-cent-seconds so the only rounding is the final one.
  const capNumerator = charged * 3600n;
  // Left within the grace period: no idle fee at all, even after the
  // tariff's step rounding billed a whole step.
  const creditNumerator =
    idleSeconds <= graceSeconds
      ? capNumerator
      : rate * BigInt(Math.floor(graceSeconds));
  const numerator =
    creditNumerator < capNumerator ? creditNumerator : capNumerator;
  return Number(roundHalfUp(numerator, 3600n * 10n ** BigInt(MICRO)));
}

export type Settlement = {
  action: "capture" | "release";
  holdCents: number;
  billTotalCents: number;
  graceCreditCents: number;
  /** What the driver owes after the grace credit. */
  dueCents: number;
  /** What the card is charged; 0 on release. */
  chargedCents: number;
  /** Owed but not charged: above the hold, or below Stripe's minimum. */
  uncollectedCents: number;
  /** The unused part of the hold that goes back to the card. */
  releasedCents: number;
  applicationFeeCents: number;
  reason: "charged" | "capped_at_hold" | "below_minimum" | "zero";
};

/**
 * Decide the final card action from Ivora's immutable bill. Capture never
 * exceeds the hold; an amount above it is shown as uncollected, never hidden.
 */
export function settle(input: {
  holdCents: number;
  billTotalCents: number;
  graceCreditCents: number;
  applicationFeeBps: number;
  /** The fee only applies when charging on the site operator's connected account. */
  chargeApplicationFee: boolean;
}): Settlement {
  const { holdCents, billTotalCents, graceCreditCents } = input;
  assertCents(holdCents, "holdCents");
  assertCents(billTotalCents, "billTotalCents");
  assertCents(graceCreditCents, "graceCreditCents");
  const dueCents = Math.max(0, billTotalCents - graceCreditCents);
  const base = { holdCents, billTotalCents, graceCreditCents, dueCents };
  if (dueCents === 0 || dueCents < MINIMUM_CHARGE_CENTS)
    return {
      ...base,
      action: "release",
      chargedCents: 0,
      uncollectedCents: dueCents,
      releasedCents: holdCents,
      applicationFeeCents: 0,
      reason: dueCents === 0 ? "zero" : "below_minimum",
    };
  const chargedCents = Math.min(dueCents, holdCents);
  return {
    ...base,
    action: "capture",
    chargedCents,
    uncollectedCents: dueCents - chargedCents,
    releasedCents: holdCents - chargedCents,
    applicationFeeCents: input.chargeApplicationFee
      ? applicationFeeCents(chargedCents, input.applicationFeeBps)
      : 0,
    reason: chargedCents < dueCents ? "capped_at_hold" : "charged",
  };
}

/** What display code falls back to when an API response carries no currency. */
export const DEFAULT_CURRENCY = "USD";
/** Locale for amounts; override per call. CAD renders as "CA$" here, so mixed demos stay unambiguous. */
export const DEFAULT_LOCALE = "en-US";

let warnedMissingCurrency = false;

/** The response's ISO 4217 code, or USD (logged once) when it carries none. */
export function resolveCurrency(currency: string | null | undefined): string {
  const code = currency?.trim().toUpperCase();
  if (code) return code;
  if (!warnedMissingCurrency) {
    warnedMissingCurrency = true;
    console.warn(
      `A response carried no currency; assuming ${DEFAULT_CURRENCY}.`,
    );
  }
  return DEFAULT_CURRENCY;
}

/** Test hook: lets the once-only warning fire again. */
export function resetCurrencyWarning(): void {
  warnedMissingCurrency = false;
}

/** Minor-unit digits of a currency: 2 for USD, 0 for JPY, 3 for KWD. */
export function currencyExponent(currency: string): number {
  return new Intl.NumberFormat(DEFAULT_LOCALE, {
    style: "currency",
    currency: resolveCurrency(currency),
  }).resolvedOptions().maximumFractionDigits!;
}

/** Minor units as a plain decimal string in major units: (1234, USD) -> "12.34". */
export function minorToMajorString(minor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const digits = String(Math.abs(Math.trunc(minor))).padStart(
    exponent + 1,
    "0",
  );
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${minor < 0 ? "-" : ""}${whole}${exponent ? `.${fraction}` : ""}`;
}

/** "12", "12.5" or "$12.55" typed in major units -> minor units, without floats. Null when invalid. */
export function majorToMinor(text: string, currency: string): number | null {
  const exponent = currencyExponent(currency);
  const m = /^[^\d\s+.,-]{0,3}\s*(\d{1,7})(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const fraction = m[2] ?? "";
  if (fraction.length > exponent) return null;
  return Number(m[1] + fraction.padEnd(exponent, "0"));
}

export function formatMoney(
  minor: number,
  currency: string,
  locale = DEFAULT_LOCALE,
): string {
  const code = resolveCurrency(currency);
  const format = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: code,
  });
  return format.format(Number(minorToMajorString(minor, code)));
}

/** A rate in minor units that may carry fractions, e.g. "45" or "35.49". */
export function formatMinorRate(
  minor: string,
  currency: string,
  locale = DEFAULT_LOCALE,
): string {
  const code = resolveCurrency(currency);
  const exponent = currencyExponent(code);
  const scaled = parseDecimal(minor, 4);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: code,
    minimumFractionDigits: exponent,
    maximumFractionDigits: Math.max(exponent, 4),
  }).format(Number(scaled) / 10 ** (4 + exponent));
}

/** Label for operator price fields: the currency and what one minor unit is, e.g. "CAD, 1 = CA$0.01". */
export function minorUnitHint(currency: string): string {
  const code = resolveCurrency(currency);
  return `${code}, 1 = ${formatMoney(1, code)}`;
}
