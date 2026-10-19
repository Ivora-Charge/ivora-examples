export function quoteCents(kwh: number, centsPerKwh: number): number {
  return Math.round(kwh * centsPerKwh);
}

export function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(
    cents / 100,
  );
}
