// Units: OCPP 1.6 meter registers are Wh, session energy is kWh, money is integer cents.
export const whToKwh = (wh: number) => wh / 1000;
export const kwhToWh = (kwh: number) => Math.round(kwh * 1000);

/**
 * Power in kW to whole watts, rounded down, for limits that must never overshoot.
 * The tiny epsilon keeps a value like 7.4 kW (7399.999... W in floating point) at 7400 W.
 */
export const wholeW = (kw: number) =>
  Number.isNaN(kw) ? 0 : Math.floor(kw * 1000 + 1e-6);

export type EnergyNeed =
  | { kind: "kwh"; kwh: number }
  | {
      kind: "battery";
      batteryKwh: number;
      currentPercent: number;
      targetPercent: number;
    };

/** Energy still to deliver, in kWh, never negative. */
export function energyNeededKwh(need: EnergyNeed): number {
  if (need.kind === "kwh") return Math.max(0, need.kwh);
  const delta =
    clampPercent(need.targetPercent) - clampPercent(need.currentPercent);
  return Math.max(0, (need.batteryKwh * delta) / 100);
}

export function clampPercent(p: number) {
  return Math.min(100, Math.max(0, p));
}

/** Energy of a transaction from start/stop meter registers in Wh, returned in kWh. */
export function sessionKwhFromRegisters(
  startWh: number,
  stopWh: number,
): number {
  return Math.max(0, whToKwh(stopWh - startWh));
}

/** Cost in integer cents for an energy amount and a per-kWh price in cents. */
export function costCents(kwh: number, centsPerKwh: number): number {
  return Math.round(kwh * centsPerKwh);
}
