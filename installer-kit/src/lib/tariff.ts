import { formatMinor } from "./money";

/**
 * Quote in integer minor units of the tariff's currency (cents for USD) from energy in
 * Wh and a price in minor units per kWh. Rounds once, half up, at the end.
 */
export function quoteMinor(energyWh: number, minorPerKwh: number): number {
  if (!Number.isInteger(minorPerKwh) || minorPerKwh < 0)
    throw new Error("Price must be a whole number of minor units per kWh.");
  return Math.round((Math.round(energyWh) * minorPerKwh) / 1000);
}

export { formatMinor };
