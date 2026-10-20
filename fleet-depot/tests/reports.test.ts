import { describe, expect, it } from "vitest";
import { buildReport, reportToCsv, type TxRecord } from "@/lib/reports";

const tx = (
  id: string,
  vehicleId: string,
  driverId: string,
  startedAt: string,
  kwh: number,
): TxRecord => ({
  id,
  vehicleId,
  driverId,
  startedAt,
  meterStartWh: 10_000,
  meterStopWh: 10_000 + kwh * 1000,
});
const txs = [
  tx("1", "v1", "d1", "2026-03-02T18:00:00Z", 20),
  tx("2", "v1", "d2", "2026-03-03T18:00:00Z", 10.5),
  tx("3", "v2", "d2", "2026-03-04T18:00:00Z", 5),
  tx("4", "v1", "d1", "2026-04-01T18:00:00Z", 99),
];
const labels = { v1: "Van 1", v2: "Van 2", d1: "Ann", d2: "=Bob" };

describe("reports", () => {
  it("aggregates per vehicle for the month with cost in cents", () => {
    const rows = buildReport(txs, "2026-03", 30, "vehicle", labels);
    expect(rows).toEqual([
      { key: "v1", label: "Van 1", sessions: 2, kwh: 30.5, costCents: 915 },
      { key: "v2", label: "Van 2", sessions: 1, kwh: 5, costCents: 150 },
    ]);
  });
  it("aggregates per driver", () => {
    const rows = buildReport(txs, "2026-03", 30, "driver", labels);
    expect(rows.find((r) => r.key === "d2")?.kwh).toBe(15.5);
  });
  it("exports CSV with header, decimal money and formula-injection guard", () => {
    const csv = reportToCsv(
      buildReport(txs, "2026-03", 30, "driver", labels),
      "EUR",
    );
    expect(csv.split("\n")[0]).toBe("name,sessions,energy_kwh,cost_eur");
    expect(csv).toContain("Ann,1,20.000,6.00");
    expect(csv).toContain("'=Bob,2,15.500,4.65");
  });
  it("quotes commas", () => {
    const csv = reportToCsv([
      { key: "x", label: 'A, "B"', sessions: 1, kwh: 1, costCents: 100 },
    ]);
    expect(csv).toContain('"A, ""B""",1,1.000,1.00');
  });
});
