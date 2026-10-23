import type { ChargerView } from "@/lib/server/chargers";

/** Status is never colour alone: a word, plus a dot (online) or square (offline). */
export function StatusPill({ c }: { c: ChargerView }) {
  if (c.pending) return <span className="pill warn">Not registered yet</span>;
  if (c.missing) return <span className="pill off">Not in Ivora</span>;
  return (
    <span className={c.online ? "pill ok" : "pill off"}>
      {c.online ? "Online" : "Offline"}
    </span>
  );
}

/** Pass, fail or not run, in words. */
export function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li>
      <span className={ok ? "pill ok" : "pill off"}>
        {ok ? "Pass" : "Fail"}
      </span>
      <span>{label}</span>
    </li>
  );
}
