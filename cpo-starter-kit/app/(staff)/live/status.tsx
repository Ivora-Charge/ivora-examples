import type { CommandView, SessionView, StationState } from "@/lib/server/live";
import { formatKwh } from "@/lib/units";

import { Chip } from "@/app/ui/status-chip";
import { PHASE_CHIPS, STATION_CHIPS, connectorChip } from "@/lib/status-chips";

// Status is never colour alone: always a word, plus the chip's shape (see lib/status-chips.ts).

export function StatePill({ state }: { state: StationState }) {
  return <Chip spec={STATION_CHIPS[state]} />;
}

/** A connector's status as the charger reports it. */
export function ConnectorPill({ status }: { status: string }) {
  return <Chip spec={connectorChip(status)} />;
}

export function PhasePill({ phase }: { phase: CommandView["phase"] }) {
  return <Chip spec={PHASE_CHIPS[phase]} />;
}

/** "Reset (soft)", "Remote start on connector 2", "Stop session 921". */
export function commandTitle(c: CommandView): string {
  switch (c.action) {
    case "start":
      return `Remote start on connector ${c.connectorNumber ?? "?"}`;
    case "stop":
      return `Stop session ${c.transactionId}`;
    case "reset":
      return `Reset (${c.mode})`;
    case "unlock":
      return `Unlock connector ${c.connectorNumber ?? "?"}`;
  }
}

/** UTC, since staff may be anywhere; the site's own time zone comes with reports. */
export const when = (iso: string | null) =>
  iso
    ? `${new Date(iso).toISOString().replace("T", " ").slice(0, 16)} UTC`
    : "—";

/** How a session is named in a confirmation: the driver's session, unmistakably. */
export const sessionLabel = (s: SessionView) =>
  `${s.staff ? "staff " : s.free ? "free " : ""}session ${s.id}${s.connectorNumber ? ` on connector ${s.connectorNumber}` : ""} (since ${when(s.startedAt)}, ${formatKwh(s.energyKwh)}${s.idToken ? `, token ${s.idToken}` : ""})`;
