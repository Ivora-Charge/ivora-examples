import Link from "next/link";
import { MODULES } from "@/lib/modules";
import { atLeast } from "@/lib/roles";
import { requireRole } from "@/lib/server/auth";
import {
  getOnboarding,
  loadOnboarding,
  loadStripe,
  setupChecklist,
  type ChecklistItem,
} from "@/lib/server/onboarding";
import { MAX_LIST_PAGES } from "@/lib/server/ivora/live";
import { loadOverview } from "@/lib/server/overview";
import { formatKwh } from "@/lib/units";

export const metadata = { title: "Overview" };

export default async function Page() {
  const me = await requireRole("viewer");
  const r = await loadOverview();
  // The setup checklist is for the people who can act on it: owners and managers.
  let checklist: ChecklistItem[] | null = null;
  if (atLeast(me.role, "manager")) {
    const d = getOnboarding();
    const [o, stripe] = await Promise.all([
      loadOnboarding(d, me),
      loadStripe(d),
    ]);
    checklist = setupChecklist(o, stripe, r.ok ? r.overview.chargers : null);
  }
  return (
    <>
      <h1>Overview</h1>
      {checklist && <Checklist items={checklist} />}
      {r.ok ? (
        <>
          {r.overview.truncated && (
            <p className="notice" role="note">
              Showing the first {(MAX_LIST_PAGES * 100).toLocaleString("en-US")}{" "}
              sites and chargers; the counts below are a lower bound.
            </p>
          )}
          <section className="stats" aria-label="Network summary">
            <Stat label="Sites" value={r.overview.sites} />
            <Stat
              label="Chargers online"
              value={`${r.overview.online} / ${r.overview.chargers}`}
            />
            <Stat label="Connectors" value={r.overview.connectors} />
            <Stat label="Charging now" value={r.overview.activeSessions} />
            <Stat
              label="Recent sessions"
              value={formatKwh(r.overview.recentEnergyKwh)}
            />
          </section>
          <section className="card" aria-labelledby="chargers-heading">
            <h2 id="chargers-heading">
              Chargers
              {r.overview.mode === "demo" && (
                <span className="badge">Sample</span>
              )}
            </h2>
            {r.overview.stations.length === 0 ? (
              <p className="muted">No chargers yet.</p>
            ) : (
              <ul className="rows">
                {r.overview.stations.map((s) => (
                  <li key={s.id}>
                    <span className="name">{s.name}</span>
                    <span className="muted">
                      {s.connectors}{" "}
                      {s.connectors === 1 ? "connector" : "connectors"}
                    </span>
                    <span className={s.online ? "pill ok" : "pill off"}>
                      {s.online ? "Online" : "Offline"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : (
        <p className="error" role="alert">
          {r.error}
        </p>
      )}
      <section className="card" aria-labelledby="next-heading">
        <h2 id="next-heading">Sections</h2>
        <ul className="rows">
          {MODULES.filter((m) => m.slug !== "overview").map((m) => (
            <li key={m.slug}>
              <Link className="name" href={m.href}>
                {m.label}
              </Link>
              <span className="muted">{m.summary}</span>
              {m.status === "coming-soon" && (
                <span className="badge">Coming soon</span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

const STATE_LABEL: Record<ChecklistItem["state"], string> = {
  done: "Done",
  todo: "To do",
  soon: "Coming soon",
};

function Checklist({ items }: { items: ChecklistItem[] }) {
  const done = items.filter((i) => i.state === "done").length;
  return (
    <section className="card" aria-labelledby="setup-heading">
      <h2 id="setup-heading">
        Setup checklist
        <span className="muted">
          {done} of {items.length} done
        </span>
      </h2>
      <ul className="rows checklist" aria-label="Setup checklist">
        {items.map((i) => (
          <li key={i.key} className={`check-${i.state}`}>
            <span className="check-mark" aria-hidden="true" />
            <span className="name">
              {i.state === "soon" ? (
                i.label
              ) : (
                <Link href={i.href}>{i.label}</Link>
              )}
            </span>
            <span className="muted">{i.detail}</span>
            <span className="check-state">{STATE_LABEL[i.state]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
