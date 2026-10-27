import { minorToMajorString } from "./money";
import { costMinor, sessionKwhFromRegisters } from "./units";

export interface TxRecord {
  id: string;
  vehicleId: string;
  driverId: string;
  startedAt: string;
  /** Meter registers in Wh. */
  meterStartWh: number;
  meterStopWh: number;
}

export interface ReportRow {
  key: string;
  label: string;
  sessions: number;
  kwh: number;
  /** Minor units of `currency` (cents for USD, none for JPY). */
  costMinor: number;
  currency: string;
}

/** What prices a transaction's energy. */
export interface Rate {
  currency: string;
  minorPerKwh: number;
}

/** "YYYY-MM" in UTC. */
export const monthOf = (iso: string) => iso.slice(0, 7);

export function buildReport(
  txs: TxRecord[],
  month: string,
  rateFor: (t: TxRecord) => Rate,
  by: "vehicle" | "driver",
  labels: Record<string, string>,
): ReportRow[] {
  const acc = new Map<string, ReportRow>();
  for (const t of txs) {
    if (monthOf(t.startedAt) !== month) continue;
    const key = by === "vehicle" ? t.vehicleId : t.driverId;
    const rate = rateFor(t);
    // One row per (name, currency): amounts in different currencies are never added.
    const id = `${key}\u0000${rate.currency}`;
    const row = acc.get(id) ?? {
      key,
      label: labels[key] ?? key,
      sessions: 0,
      kwh: 0,
      costMinor: 0,
      currency: rate.currency,
    };
    const kwh = sessionKwhFromRegisters(t.meterStartWh, t.meterStopWh);
    row.sessions += 1;
    row.kwh += kwh;
    // Price each session, then sum: a driver's sessions may use different rates.
    row.costMinor += costMinor(kwh, rate.minorPerKwh);
    acc.set(id, row);
  }
  return [...acc.values()]
    .map((r) => ({ ...r, kwh: Math.round(r.kwh * 1000) / 1000 }))
    .sort(
      (a, b) =>
        a.label.localeCompare(b.label) || a.currency.localeCompare(b.currency),
    );
}

function cell(v: string | number) {
  const s = String(v);
  // Neutralise spreadsheet formula injection, then quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) && typeof v === "string" ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One file, one row per name and currency; the amount is a plain decimal in that currency. */
export function reportToCsv(rows: ReportRow[]): string {
  const head = ["name", "sessions", "energy_kwh", "currency", "cost"];
  const body = rows.map((r) =>
    [
      r.label,
      r.sessions,
      r.kwh.toFixed(3),
      r.currency,
      minorToMajorString(r.costMinor, r.currency),
    ]
      .map(cell)
      .join(","),
  );
  return [head.join(","), ...body].join("\n") + "\n";
}
