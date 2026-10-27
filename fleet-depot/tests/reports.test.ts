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

const usd = () => ({ currency: "USD", minorPerKwh: 30 });

describe("reports", () => {
  it("aggregates per vehicle for the month with cost in minor units", () => {
    const rows = buildReport(txs, "2026-03", usd, "vehicle", labels);
    expect(rows).toEqual([
      {
        key: "v1",
        label: "Van 1",
        sessions: 2,
        kwh: 30.5,
        costMinor: 915,
        currency: "USD",
      },
      {
        key: "v2",
        label: "Van 2",
        sessions: 1,
        kwh: 5,
        costMinor: 150,
        currency: "USD",
      },
    ]);
  });
  it("aggregates per driver", () => {
    const rows = buildReport(txs, "2026-03", usd, "driver", labels);
    expect(rows.find((r) => r.key === "d2")?.kwh).toBe(15.5);
  });
  it("splits a name that has sessions in two currencies instead of adding them", () => {
    const rate = (t: TxRecord) =>
      t.vehicleId === "v2"
        ? { currency: "CAD", minorPerKwh: 20 }
        : { currency: "USD", minorPerKwh: 30 };
    const rows = buildReport(txs, "2026-03", rate, "driver", labels);
    const bob = rows.filter((r) => r.key === "d2");
    expect(bob.map((r) => [r.currency, r.costMinor])).toEqual([
      ["CAD", 100],
      ["USD", 315],
    ]);
  });
  it("prices zero- and three-decimal currencies in their own minor units", () => {
    const jpy = buildReport(
      txs,
      "2026-03",
      () => ({ currency: "JPY", minorPerKwh: 30 }),
      "vehicle",
      labels,
    );
    expect(jpy[1].costMinor).toBe(150);
    const csv = reportToCsv(jpy);
    expect(csv).toContain("Van 2,1,5.000,JPY,150\n");
    const kwd = reportToCsv(
      buildReport(
        txs,
        "2026-03",
        () => ({ currency: "KWD", minorPerKwh: 30 }),
        "vehicle",
        labels,
      ),
    );
    expect(kwd).toContain("Van 2,1,5.000,KWD,0.150\n");
  });
  it("exports CSV with header, decimal money and formula-injection guard", () => {
    const csv = reportToCsv(buildReport(txs, "2026-03", usd, "driver", labels));
    expect(csv.split("\n")[0]).toBe("name,sessions,energy_kwh,currency,cost");
    expect(csv).toContain("Ann,1,20.000,USD,6.00");
    expect(csv).toContain("'=Bob,2,15.500,USD,4.65");
  });
  it("quotes commas", () => {
    const csv = reportToCsv([
      {
        key: "x",
        label: 'A, "B"',
        sessions: 1,
        kwh: 1,
        costMinor: 100,
        currency: "CAD",
      },
    ]);
    expect(csv).toContain('"A, ""B""",1,1.000,CAD,1.00');
  });
});
