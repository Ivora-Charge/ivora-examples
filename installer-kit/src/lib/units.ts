/** OCPP 1.6 meter registers are Wh; session energy is shown in kWh. */
export function whToKwh(energyWh: number): number {
  return Math.round(energyWh) / 1000;
}

/** Parse the API's decimal kWh text (for example "0.425") into integer Wh. */
export function kwhTextToWh(energyKwh: string | number | null | undefined) {
  if (energyKwh === null || energyKwh === undefined || energyKwh === "")
    return 0;
  const value = Number(energyKwh);
  return Number.isFinite(value) ? Math.round(value * 1000) : 0;
}

/** Two decimals, rounded half up in integer tens of Wh (no float drift). */
export function formatKwh(energyWh: number): string {
  return `${(Math.round(energyWh / 10) / 100).toFixed(2)} kWh`;
}
