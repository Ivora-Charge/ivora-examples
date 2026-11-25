import type { Card } from "./charging";

/**
 * What a signed-in driver's cards allow before a start:
 * - `ready`: a card pays for charging, so the charge can start;
 * - `wallet`: none does, and the Wallet tab can fix that (choose one, or add one where
 *   this build saves cards);
 * - `phoneApp`: no card is saved and this build cannot save one (the web build), so the
 *   Wallet tab would lead nowhere: the driver saves a card in the phone app.
 */
export type CardStep = "ready" | "wallet" | "phoneApp";

export function cardStep(
  cards: Pick<Card, "isDefault">[],
  canAddCard: boolean,
): CardStep {
  if (cards.some((c) => c.isDefault)) return "ready";
  return !canAddCard && cards.length === 0 ? "phoneApp" : "wallet";
}
