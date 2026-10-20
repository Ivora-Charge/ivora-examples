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
