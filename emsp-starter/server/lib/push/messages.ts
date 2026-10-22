import "server-only";
import { minorDigits } from "@/lib/payments/money";

/**
 * The words of push notifications, per language. The app sends its device's language
 * with its push token; English fills any language or key without its own text. To add
 * a language, add it to MESSAGES with the same keys.
 *
 * Amounts are formatted for the device's locale (Intl), in the payment's currency.
 */
export type PushKind =
  | "charging_done"
  | "start_failed"
  | "start_not_supported"
  | "start_no_answer"
  | "stop_failed"
  | "stop_no_answer"
  | "hold_increment_declined";

type Texts = Record<PushKind, { title: string; body: string }>;

const EN: Texts = {
  charging_done: {
    title: "Charging finished",
    body: "Your session ended after {kwh} kWh. The receipt follows once the operator sends the final bill.",
  },
  start_failed: {
    title: "Charging didn't start",
    body: "The charger couldn't start. Nothing was charged.",
  },
  start_not_supported: {
    title: "Charging didn't start",
    body: "This charger doesn't accept app starts. Nothing was charged.",
  },
  start_no_answer: {
    title: "No answer from the charger",
    body: "The charger didn't answer. If it isn't charging, nothing is charged.",
  },
  stop_failed: {
    title: "The charger didn't stop",
    body: "The charger couldn't stop. Open the app to try again.",
  },
  stop_no_answer: {
    title: "No answer from the charger",
    body: "The charger didn't answer the stop. Open the app to check.",
  },
  hold_increment_declined: {
    title: "Charging stopped",
    body: "Your card didn't approve more charging; session stopped at {amount}.",
  },
};

export const MESSAGES: Record<string, Partial<Texts>> = { en: EN };

const fill = (s: string, vars: Record<string, string>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);

/** A locale tag Intl accepts, else "en". */
function safeLocale(locale: string): string {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? "en";
  } catch {
    return "en";
  }
}

/** Minor units as a price in `locale`: 2500 EUR is "€25.00" in en, "25,00 €" in de. */
export function formatAmount(
  minor: number,
  currency: string,
  locale: string,
): string {
  const digits = minorDigits(currency);
  const value = minor / 10 ** digits;
  try {
    return new Intl.NumberFormat(safeLocale(locale), {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return `${value.toFixed(digits)} ${currency}`;
  }
}

/** A number of kWh for `locale`, at most 2 decimals. */
export function formatKwh(kwh: number, locale: string): string {
  try {
    return new Intl.NumberFormat(safeLocale(locale), {
      maximumFractionDigits: 2,
    }).format(kwh);
  } catch {
    return String(Math.round(kwh * 100) / 100);
  }
}

/** The title and body of a notification, in the device's language where we have it. */
export function pushText(
  kind: PushKind,
  locale: string,
  vars: Record<string, string>,
): { title: string; body: string } {
  const lang = safeLocale(locale).split("-")[0].toLowerCase();
  const t = MESSAGES[lang]?.[kind] ?? EN[kind];
  return { title: fill(t.title, vars), body: fill(t.body, vars).trim() };
}
