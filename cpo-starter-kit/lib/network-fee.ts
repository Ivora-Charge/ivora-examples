import { currencyExponent, minorToMajorString, parseMajor } from "./money";

// Network mode: the operator's network fee on a site host's sessions. Pure integer
// arithmetic in minor units, shared by the server (statements, session rows, and the
// application fee once host payouts take card payments) and the tests.
//
// The one rounding rule (README: Network fee): each fee is computed from integers and
// rounded once, half up, at the end. A percentage fee is captured × basis points /
// 10,000; a per-kWh fee is the rate × energy in Wh / 1,000. A fee is never more than
// what was captured, so the host's share is never negative. A refund returns the fee
// in proportion: in total, fee × refunded / captured, rounded half up once on the
// running total, so several partial refunds never return more than the fee.

/** How the fee is worked out: a share of the session amount, or an amount per kWh. */
export type FeeMode = "percent" | "per_kwh";

/** The operator's terms for one host. Amounts are integer minor units of `currency`. */
export interface FeeTerms {
  mode: FeeMode;
  /** percent: basis points of the captured amount (1,000 = 10%). 0 to 10,000. */
  percentBps: number;
  /** per_kwh: minor units per kWh of energy delivered. */
  perKwhMinor: number;
  /**
   * A fixed monthly fee per charger, shown on the statement and never collected by the
   * kit (the operator invoices it, or takes it, outside the kit).
   */
  monthlyChargerFeeMinor: number;
  /** The currency of the per-kWh and monthly amounts (the company's when saved). */
  currency: string;
}

/** Upper bounds that keep every product a safe integer. */
export const FEE_LIMITS = {
  percentBps: 10_000,
  /** 100.00 a kWh in a 2-decimal currency. */
  perKwhMinor: 10_000,
  /** 10,000.00 a charger a month in a 2-decimal currency. */
  monthlyChargerFeeMinor: 1_000_000,
} as const;

export const ZERO_TERMS = (currency: string): FeeTerms => ({
  mode: "percent",
  percentBps: 0,
  perKwhMinor: 0,
  monthlyChargerFeeMinor: 0,
  currency,
});

/**
 * Stripe's smallest charge, in minor units, for the currencies the kit's tests cover.
 * Below it nothing is captured (the hold is released), so there is no fee either.
 */
export const MINIMUM_CHARGE_MINOR: Record<string, number> = {
  USD: 50,
  CAD: 50,
};

/** Integer division rounded half up, for non-negative integers. */
export function divideHalfUp(numerator: number, denominator: number): number {
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator < 0 ||
    denominator <= 0
  )
    throw new Error("divideHalfUp takes a non-negative and a positive integer");
  const q = Math.floor(numerator / denominator);
  const r = numerator - q * denominator;
  return r * 2 >= denominator ? q + 1 : q;
}

const isAmount = (n: unknown, max: number): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= max;

/** Terms the database and forms accept: whole numbers inside FEE_LIMITS. */
export function validTerms(t: FeeTerms): boolean {
  return (
    (t.mode === "percent" || t.mode === "per_kwh") &&
    isAmount(t.percentBps, FEE_LIMITS.percentBps) &&
    isAmount(t.perKwhMinor, FEE_LIMITS.perKwhMinor) &&
    isAmount(t.monthlyChargerFeeMinor, FEE_LIMITS.monthlyChargerFeeMinor) &&
    /^[A-Z]{3}$/.test(t.currency)
  );
}

export interface SessionMoney {
  /** What was captured from the driver's card (0 when the hold was released). */
  capturedMinor: number;
  /** Energy delivered, integer Wh; null while not recorded. */
  energyWh: number | null;
  currency: string;
}

export type FeeResult =
  | { ok: true; feeMinor: number; hostShareMinor: number }
  /**
   * energy: a per-kWh fee on a session whose energy is not recorded yet.
   * currency: a per-kWh fee in another currency than the session's (never converted).
   */
  | { ok: false; reason: "energy" | "currency" };

/**
 * The network fee on one session and the host's share (captured minus the fee).
 * Nothing captured (a released hold, a bill under the minimum charge, a free
 * session): no fee. A fee above the captured amount is cut to it.
 */
export function networkFee(terms: FeeTerms, s: SessionMoney): FeeResult {
  if (!validTerms(terms)) throw new Error("Invalid fee terms");
  const captured = s.capturedMinor;
  if (!Number.isSafeInteger(captured) || captured < 0)
    throw new Error("capturedMinor must be a non-negative integer");
  if (captured === 0) return { ok: true, feeMinor: 0, hostShareMinor: 0 };
  let fee: number;
  if (terms.mode === "percent") {
    fee = divideHalfUp(captured * terms.percentBps, 10_000);
  } else {
    if (terms.perKwhMinor === 0)
      return { ok: true, feeMinor: 0, hostShareMinor: captured };
    if (s.currency !== terms.currency) return { ok: false, reason: "currency" };
    if (
      s.energyWh === null ||
      !Number.isSafeInteger(s.energyWh) ||
      s.energyWh < 0
    )
      return { ok: false, reason: "energy" };
    fee = divideHalfUp(terms.perKwhMinor * s.energyWh, 1_000);
  }
  fee = Math.min(fee, captured);
  return { ok: true, feeMinor: fee, hostShareMinor: captured - fee };
}

/**
 * How much of the fee goes back after refunds totalling `refundedMinor` of
 * `capturedMinor`: fee × refunded / captured, half up, never more than the fee.
 */
export function feeRefunded(
  feeMinor: number,
  capturedMinor: number,
  refundedMinor: number,
): number {
  if (capturedMinor <= 0 || feeMinor <= 0 || refundedMinor <= 0) return 0;
  const refunded = Math.min(refundedMinor, capturedMinor);
  return Math.min(feeMinor, divideHalfUp(feeMinor * refunded, capturedMinor));
}

/**
 * What a further refund returns of the fee, given what earlier refunds returned: the
 * difference of the running totals, so rounding never adds up past the fee.
 */
export function feeRefundStep(
  feeMinor: number,
  capturedMinor: number,
  refundedBeforeMinor: number,
  refundMinor: number,
): number {
  return (
    feeRefunded(feeMinor, capturedMinor, refundedBeforeMinor + refundMinor) -
    feeRefunded(feeMinor, capturedMinor, refundedBeforeMinor)
  );
}

/** "10" or "7.25" (percent, at most 2 decimals) to basis points, or null. */
export function parsePercent(text: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{0,2}))?\s*%?$/.exec(text.trim());
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return bps <= FEE_LIMITS.percentBps ? bps : null;
}

/** 725 basis points to "7.25%". */
export function formatPercent(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}%`;
}

/** An amount staff typed for the fee (major units) to minor units, or null. */
export function parseFeeAmount(
  text: string,
  currency: string,
  max: number,
): number | null {
  const t = text.trim();
  if (t === "") return 0;
  const v = parseMajor(t, currency);
  return v !== null && v <= max ? v : null;
}

/** The terms in words, for pages and statements. */
export function describeTerms(
  t: FeeTerms,
  format: (minor: number, currency: string) => string,
): string {
  const fee =
    t.mode === "percent"
      ? `${formatPercent(t.percentBps)} of each session's amount`
      : `${format(t.perKwhMinor, t.currency)} per kWh`;
  const monthly =
    t.monthlyChargerFeeMinor > 0
      ? `; ${format(t.monthlyChargerFeeMinor, t.currency)} a month per charger (not collected by the kit)`
      : "";
  return `${fee}${monthly}`;
}

/** The per-kWh rate as text for a form field ("0.05"). */
export const amountField = (minor: number, currency: string) =>
  minor === 0 ? "" : minorToMajorString(minor, currency);

/** Decimal places a fee amount may have in this currency. */
export const feeDecimals = (currency: string) => currencyExponent(currency);
