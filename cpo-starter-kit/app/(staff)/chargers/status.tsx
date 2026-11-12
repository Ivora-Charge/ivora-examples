import { StatusChip } from "@/app/ui/status-chip";
import type { ChargerView } from "@/lib/server/chargers";

/** Status is never colour alone: a word, plus a dot (online) or square (offline). */
export function StatusPill({ c }: { c: ChargerView }) {
  if (c.pending) return <StatusChip tone="warn">Not registered yet</StatusChip>;
  if (c.missing) return <StatusChip tone="off">Not in Ivora</StatusChip>;
  return (
    <StatusChip tone={c.online ? "ok" : "off"}>
      {c.online ? "Online" : "Offline"}
    </StatusChip>
  );
}

/** Pass, fail or not run, in words. */
export function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li>
      <StatusChip tone={ok ? "ok" : "off"}>{ok ? "Pass" : "Fail"}</StatusChip>
      <span>{label}</span>
    </li>
  );
}
