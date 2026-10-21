// Time zones and currencies the company form offers, from the runtime's own lists
// (IANA zones and ISO 4217 codes), so nothing is hard-coded or out of date.

const supported = (key: "timeZone" | "currency"): string[] => {
  try {
    return Intl.supportedValuesOf(key);
  } catch {
    return [];
  }
};

/** IANA time zones, UTC first. */
export const TIME_ZONES: readonly string[] = [
  "UTC",
  ...supported("timeZone").filter((z) => z !== "UTC"),
];

/** ISO 4217 currency codes, USD first: Ivora Checkout settles Stripe payments in USD. */
export const CURRENCIES: readonly string[] = [
  "USD",
  ...supported("currency").filter((c) => c !== "USD" && /^[A-Z]{3}$/.test(c)),
];
