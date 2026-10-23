import type { CommandView, StationState } from "@/lib/server/live";

// Status is never colour alone: always a word, plus the pill's dot or square.

const STATE: Record<StationState, { label: string; cls: string }> = {
  online: { label: "Online", cls: "pill ok" },
  offline: { label: "Offline", cls: "pill off" },
  faulted: { label: "Faulted", cls: "pill warn" },
};

export function StatePill({ state }: { state: StationState }) {
  return <span className={STATE[state].cls}>{STATE[state].label}</span>;
}

const IN_USE = new Set([
  "Preparing",
  "Charging",
  "SuspendedEV",
  "SuspendedEVSE",
  "Finishing",
  "Reserved",
]);

/** A connector's status as the charger reports it. */
export function ConnectorPill({ status }: { status: string }) {
  const cls =
    status === "Available"
      ? "pill ok"
      : IN_USE.has(status)
        ? "pill busy"
        : status === "Faulted"
          ? "pill warn"
          : "pill off";
  return <span className={cls}>{status}</span>;
}

const PHASE: Record<CommandView["phase"], { label: string; cls: string }> = {
  pending: { label: "Waiting for answer", cls: "pill busy" },
  accepted: { label: "Accepted", cls: "pill ok" },
  failed: { label: "Not done", cls: "pill off" },
  unknown: { label: "Outcome unknown", cls: "pill warn" },
};

export function PhasePill({ phase }: { phase: CommandView["phase"] }) {
  return <span className={PHASE[phase].cls}>{PHASE[phase].label}</span>;
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
