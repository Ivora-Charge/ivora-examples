/**
 * Quote in integer cents from energy in Wh and a price in cents per kWh.
 * Rounds once, half up, at the end.
 */
export function quoteCents(energyWh: number, centsPerKwh: number): number {
  if (!Number.isInteger(centsPerKwh) || centsPerKwh < 0)
    throw new Error("Price must be a whole number of cents per kWh.");
  return Math.round((Math.round(energyWh) * centsPerKwh) / 1000);
}

export function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    cents / 100,
  );
}
