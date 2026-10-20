// OCPP 1.6 meter registers are Wh; session energy is shown in kWh. Convert in
// one place, on integers, and only for display.

export function assertWh(wh: number): void {
  if (!Number.isSafeInteger(wh) || wh < 0)
    throw new Error("Energy must be a non-negative whole number of Wh.");
}

/** 12345 Wh -> "12.35" kWh (half up, 2 decimals). */
export function whToKwhText(wh: number, decimals = 2): string {
  assertWh(wh);
  const step = 10 ** (3 - decimals); // Wh per displayed digit
  const rounded = Math.floor((wh + step / 2) / step) * step;
  const whole = Math.floor(rounded / 1000);
  const fraction = String(rounded % 1000)
    .padStart(3, "0")
    .slice(0, decimals);
  return decimals > 0 ? `${whole}.${fraction}` : String(whole);
}

/** 61234 W -> "61.2" kW (half up, 1 decimal). */
export function wToKwText(watts: number): string {
  if (!Number.isFinite(watts) || watts < 0) return "0.0";
  return (Math.floor(watts / 100 + 0.5) / 10).toFixed(1);
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
