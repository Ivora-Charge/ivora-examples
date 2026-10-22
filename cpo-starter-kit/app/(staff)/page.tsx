import Link from "next/link";
import { visibleModules } from "@/lib/modules";
import { atLeast } from "@/lib/roles";
import { requireRole } from "@/lib/server/auth";
import { config } from "@/lib/server/env";
import {
  getOnboarding,
  loadOnboarding,
  loadStripe,
  setupChecklist,
  type ChecklistItem,
} from "@/lib/server/onboarding";
import { MAX_LIST_PAGES } from "@/lib/server/ivora/live";
import { getPricing, pricingProgress } from "@/lib/server/pricing";
import { loadOverview } from "@/lib/server/overview";
import { formatKwh } from "@/lib/units";
import { Loading } from "@/app/loading-skeleton";

export const metadata = { title: "Overview" };

/** "incl. 2 staff/test, 1 free": sessions that are not paid driver sessions. */
function sessionsNote(o: { staffSessions: number; freeSessions: number }) {
  const parts = [];
  if (o.staffSessions) parts.push(`${o.staffSessions} staff/test`);
  if (o.freeSessions) parts.push(`${o.freeSessions} free`);
  return parts.length ? `incl. ${parts.join(", ")}` : undefined;
}

async function Content() {
  const me = await requireRole("viewer");
  const r = await loadOverview(me.operatorId);
  // The setup checklist is for the people who can act on it: owners and managers.
  let checklist: ChecklistItem[] | null = null;
  if (atLeast(me.role, "manager")) {
    const d = getOnboarding();
    const [o, stripe, prices] = await Promise.all([
      loadOnboarding(d, me),
      loadStripe(d),
      pricingProgress(getPricing().store, me.operatorId),
    ]);
    checklist = setupChecklist(
      o,
      stripe,
      r.ok ? r.overview.chargers : null,
      prices,
    );
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
              label="Energy charging now"
              value={formatKwh(r.overview.activeEnergyKwh)}
              note={sessionsNote(r.overview)}
            />
          </section>
          {!r.overview.sessionsComplete && (
            <p className="muted" role="note">
              The sessions may lag: some chargers have not been checked yet.
              They are on the next load, or on <Link href="/live">Live</Link>.
            </p>
          )}
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
          {visibleModules({ fleet: config.fleetModule })
            .filter((m) => m.slug !== "overview")
            .map((m) => (
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

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string | number;
  note?: string;
}) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">
        {label}
        {note ? ` (${note})` : ""}
      </span>
    </div>
  );
}

/** Checks the role first (a real redirect), then the page behind its loading skeleton. */
export default async function Page() {
  await requireRole("viewer");
  return (
    <Loading shape="stats">
      <Content />
    </Loading>
  );
}
