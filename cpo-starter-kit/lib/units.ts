/** OCPP meter registers are Wh; sessions are shown in kWh. The only Wh to kWh conversion. */
export function whToKwh(energyWh: number): number {
  return energyWh / 1000;
}

/** kWh for display, with up to `digits` decimals. */
export function formatKwh(energyKwh: number, digits = 1): string {
  return `${energyKwh.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  })} kWh`;
}

/**
 * Integer Wh as exact kWh decimal text, the way the API writes energy_kwh: 28941 is
 * "28.941", 22000 is "22". For exports, where a float could print 28.940999.
 */
export function whToKwhText(energyWh: number): string {
  if (!Number.isSafeInteger(energyWh)) throw new Error("Wh must be an integer");
  const sign = energyWh < 0 ? "-" : "";
  const abs = Math.abs(energyWh);
  const frac = String(abs % 1000)
    .padStart(3, "0")
    .replace(/0+$/, "");
  return `${sign}${Math.floor(abs / 1000)}${frac ? `.${frac}` : ""}`;
}
