import { i18n, t } from "../i18n";
import type { Card, StartProblem, StopCode } from "./charging";

/**
 * The app's own words for the server's codes. The server's messages are English only,
 * so the screens show these instead.
 */
const PROBLEM: Record<StartProblem, () => string> = {
  card: () => t("start.problem.card"),
  notSupported: () => t("start.problem.notSupported"),
  occupied: () => t("start.problem.occupied"),
  inoperative: () => t("start.problem.inoperative"),
  timedOut: () => t("start.problem.timedOut"),
  failed: () => t("start.problem.failed"),
};

export const problemText = (p: StartProblem) => PROBLEM[p]();

/** Card networks' own names (not translated). */
const BRANDS: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
  cartes_bancaires: "Cartes Bancaires",
};

/** "Visa •••• 4242". */
export const cardLabel = (card: Pick<Card, "brand" | "last4">) =>
  t("wallet.cardLabel", {
    brand: BRANDS[card.brand] ?? t("wallet.cardGeneric"),
    last4: card.last4,
  });

/** "Expires 12/2029". */
export const cardExpiry = (card: Pick<Card, "expMonth" | "expYear">) =>
  card.expMonth && card.expYear
    ? t("wallet.expires", {
        date: `${String(card.expMonth).padStart(2, "0")}/${card.expYear}`,
      })
    : "";

/**
 * Why we stopped a session, never as a charger fault. `amount` is what the card
 * covered, in minor units: "Your card didn't approve more charging; session stopped at
 * €25.00."
 */
export function stopText(
  code: StopCode,
  amount?: { minor: number; currency: string },
): string | null {
  if (code === "hold_increment_declined")
    return amount
      ? t("charge.declined", {
          amount: i18n.minor(amount.minor, amount.currency),
        })
      : t("charge.declinedShort");
  if (code === "other") return t("charge.stoppedByUs");
  return null;
}
