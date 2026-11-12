import { StatusChip } from "@/app/ui/status-chip";
import type { ChargerView } from "@/lib/server/chargers";
import { zonedTime } from "@/lib/charger-table";

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

/**
 * An instant in the charger's time zone (its site's, else the company's, else UTC),
 * with UTC beneath it as the secondary detail.
 */
export function When({ iso, zone }: { iso: string | null; zone: string }) {
  const t = zonedTime(iso, zone);
  if (!t) return <span className="muted">Never</span>;
  if (t.zone === "UTC") return <time dateTime={iso!}>{t.utc}</time>;
  return (
    <span className="when">
      <time dateTime={iso!}>
        {t.local} <span className="muted">{t.zone}</span>
      </time>
      <small className="muted">{t.utc}</small>
    </span>
  );
}
