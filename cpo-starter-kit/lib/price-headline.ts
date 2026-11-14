/**
 * Splits the driver price text (the tariff's driver description) for display only: the
 * first clause, for example "$0.35 per kWh", becomes the large headline and the rest
 * (peak rates, session fee, idle fee, time zone) stays in normal text. The words and
 * order are unchanged; nothing is computed. A long first clause, as an operator's own
 * description may have, is not made big.
 */
export const HEADLINE_MAX = 40;

export function splitPriceText(text: string): {
  headline: string | null;
  rest: string;
} {
  const trimmed = text.trim();
  const match = /;\s|\.\s|\.$/.exec(trimmed);
  const head = (match ? trimmed.slice(0, match.index) : trimmed).trim();
  if (!head || head.length > HEADLINE_MAX)
    return { headline: null, rest: trimmed };
  let rest = match ? trimmed.slice(match.index + 1).trim() : "";
  if (rest) rest = `${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
  return { headline: head, rest };
}
