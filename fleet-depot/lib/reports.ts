import { costCents, sessionKwhFromRegisters } from "./units";

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
  costCents: number;
}

/** "YYYY-MM" in UTC. */
export const monthOf = (iso: string) => iso.slice(0, 7);

export function buildReport(
  txs: TxRecord[],
  month: string,
  centsPerKwh: number,
  by: "vehicle" | "driver",
  labels: Record<string, string>,
): ReportRow[] {
  const acc = new Map<string, ReportRow>();
  for (const t of txs) {
    if (monthOf(t.startedAt) !== month) continue;
    const key = by === "vehicle" ? t.vehicleId : t.driverId;
    const row = acc.get(key) ?? {
      key,
      label: labels[key] ?? key,
      sessions: 0,
      kwh: 0,
      costCents: 0,
    };
    row.sessions += 1;
    row.kwh += sessionKwhFromRegisters(t.meterStartWh, t.meterStopWh);
    acc.set(key, row);
  }
  return [...acc.values()]
    .map((r) => ({
      ...r,
      kwh: Math.round(r.kwh * 1000) / 1000,
      costCents: costCents(r.kwh, centsPerKwh),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function cell(v: string | number) {
  const s = String(v);
  // Neutralise spreadsheet formula injection, then quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) && typeof v === "string" ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function reportToCsv(rows: ReportRow[], currency = "EUR"): string {
  const head = [
    "name",
    "sessions",
    "energy_kwh",
    `cost_${currency.toLowerCase()}`,
  ];
  const body = rows.map((r) =>
    [r.label, r.sessions, r.kwh.toFixed(3), (r.costCents / 100).toFixed(2)]
      .map(cell)
      .join(","),
  );
  return [head.join(","), ...body].join("\n") + "\n";
}
