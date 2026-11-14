import { splitPriceText } from "@/lib/price-headline";

/**
 * The tariff's price text for drivers: the headline rate large, everything else (peak
 * rates, session fee, idle fee, time zone) at body size. Display only; the text is the
 * same string the page showed before, split at its first clause.
 */
export function PriceText({ text }: { text: string }) {
  const { headline, rest } = splitPriceText(text);
  return (
    <>
      {headline && (
        <p className="price-big" data-testid="price-headline">
          {headline}
        </p>
      )}
      {rest && <p data-testid="price-detail">{rest}</p>}
    </>
  );
}
