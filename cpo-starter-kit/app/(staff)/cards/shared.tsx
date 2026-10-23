import type { Card } from "@/lib/server/fleet";
import { lastValidDay } from "@/lib/server/fleet";
import { formatKwh, whToKwh } from "@/lib/units";

export const PERIOD_LABELS: Record<number, string> = {
  7: "Last 7 days",
  30: "Last 30 days",
  90: "Last 90 days",
  365: "Last 12 months",
};

export const kwh = (wh: number) => formatKwh(whToKwh(wh));

/** The card's state in words and shape (never colour alone). */
export function StatePill({ card, zone }: { card: Card; zone: string }) {
  if (card.state === "active")
    return (
      <span className="pill ok">
        Active
        {card.expiresAt ? `, until ${lastValidDay(card.expiresAt, zone)}` : ""}
      </span>
    );
  if (card.state === "blocked")
    return <span className="pill off">Blocked</span>;
  if (card.state === "expired")
    return (
      <span className="pill off">
        Expired
        {card.status === "Accepted" && card.expiresAt ? ` (date passed)` : ""}
      </span>
    );
  return <span className="pill warn">{card.status}</span>;
}

export function holderText(card: Card) {
  if (!card.holder.name) return "No label";
  return card.holder.kind
    ? `${card.holder.kind === "driver" ? "Driver" : "Vehicle"}: ${card.holder.name}`
    : card.holder.name;
}

export function PeriodSelect({ days, id }: { days: number; id: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>Sessions and energy</label>
      <select id={id} name="days" defaultValue={String(days)}>
        {Object.entries(PERIOD_LABELS).map(([d, label]) => (
          <option key={d} value={d}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

export const FLEET_DEPOT_URL =
  "https://github.com/Ivora-Charge/ivora-examples/tree/main/fleet-depot";
