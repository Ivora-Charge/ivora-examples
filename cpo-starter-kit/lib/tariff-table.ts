import { formatMinor } from "./money";
import type { ChipSpec } from "./status-chips";

// Presentation only: how a stored tariff reads in the Pricing table. Nothing here
// prices a session or changes a stored value; amounts are formatted as stored.

/** The parts of a stored tariff definition the table shows. */
export interface TariffFacts {
  kind: "paid" | "free";
  currency: string;
  energyMinorPerKwh: number;
  idleMinorPerMinute: number;
  idleGraceMinutes: number;
  periods: { energyMinorPerKwh: number }[];
}

/** "Free", "Time of use", "Per kWh" or "Per kWh + idle fee". */
export function tariffType(d: TariffFacts | null): string {
  if (!d) return "Not live yet";
  if (d.kind === "free") return "Free";
  if (d.periods.length > 0) return "Time of use";
  return d.idleMinorPerMinute > 0 ? "Per kWh + idle fee" : "Per kWh";
}

/** "$0.35", "$0.30–0.45" when periods differ, "Free", or "n/a". */
export function tariffEnergy(d: TariffFacts | null): string {
  if (!d) return "n/a";
  if (d.kind === "free") return "Free";
  const all = [
    d.energyMinorPerKwh,
    ...d.periods.map((p) => p.energyMinorPerKwh),
  ];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  if (lo === hi) return formatMinor(lo, d.currency);
  // "$0.30–0.45": the symbol once, as in the mockup.
  const high = formatMinor(hi, d.currency);
  const symbolEnd = high.search(/\d/);
  return `${formatMinor(lo, d.currency)}–${high.slice(symbolEnd)}`;
}

/** "$0.20 / min", with the free minutes when there are some; "none" without an idle fee. */
export function tariffIdle(d: TariffFacts | null): string {
  if (!d || d.kind === "free") return "n/a";
  if (d.idleMinorPerMinute <= 0) return "none";
  const grace =
    d.idleGraceMinutes > 0 ? ` after ${d.idleGraceMinutes} min` : "";
  return `${formatMinor(d.idleMinorPerMinute, d.currency)} / min${grace}`;
}

/** The state chip: not confirmed by Ivora, in use, or not yet given to a connector. */
export function tariffState(t: {
  needsFinishing: boolean;
  connectors: number;
}): ChipSpec {
  if (t.needsFinishing) return { label: "Not confirmed", tone: "warn" };
  if (t.connectors > 0) return { label: "In use", tone: "ok" };
  return { label: "Unassigned", tone: "idle" };
}
