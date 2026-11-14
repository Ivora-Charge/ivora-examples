import Link from "next/link";
import { cookies } from "next/headers";
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
import { loadTrend } from "@/lib/server/overview-trend";
import { getReports } from "@/lib/server/reports";
import { SETUP_HIDDEN_COOKIE } from "@/lib/setup-hidden";
import { formatKwh, whToKwh } from "@/lib/units";
import { Loading } from "@/app/loading-skeleton";
import { BarChart } from "@/app/ui/bar-chart";
import { EmptyState } from "@/app/ui/empty-state";
import { PageHeader } from "@/app/ui/page-header";
import { hideSetupAction, showSetupAction } from "./setup-actions";

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
  const [r, trend] = await Promise.all([
    loadOverview(me.operatorId),
    loadTrend(getReports(), me),
  ]);
  const hidden = (await cookies()).get(SETUP_HIDDEN_COOKIE)?.value === "1";
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
  // Until setup is done (or hidden) the checklist leads; after that the key numbers
  // and the 30-day chart do, and the checklist is one collapsed line under them.
  const setupOpen =
    checklist !== null && !hidden && checklist.some((i) => i.state === "todo");
  const setup = checklist && (
    <Checklist items={checklist} open={setupOpen} hidden={hidden} />
  );
  return (
    <>
      <PageHeader
        title="Overview"
        description="Your network now, and the last 30 days."
      />
      {setupOpen && setup}
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
          <Trend trend={trend} />
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
      {!setupOpen && setup}
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

function Checklist({
  items,
  open,
  hidden,
}: {
  items: ChecklistItem[];
  open: boolean;
  hidden: boolean;
}) {
  const done = items.filter((i) => i.state === "done").length;
  return (
    <details className="card setup" open={open}>
      <summary id="setup-heading">
        <h2>Setup checklist</h2>
        <span className="muted">
          {done} of {items.length} done
        </span>
      </summary>
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
      <form action={hidden ? showSetupAction : hideSetupAction}>
        <button type="submit" className="button secondary">
          {hidden ? "Show the checklist at the top" : "Hide the checklist"}
        </button>
      </form>
    </details>
  );
}

/** One chart of the last 30 days; a failed read says so and the rest of the page stays. */
function Trend({ trend }: { trend: Awaited<ReturnType<typeof loadTrend>> }) {
  const r = trend.result;
  if (!r.ok)
    return (
      <EmptyState tone="error" title="The 30-day chart is unavailable">
        {r.error} The numbers above are not affected.
      </EmptyState>
    );
  const s = r.stats;
  const bars = s.series.map((b) => {
    const [, m, d] = b.start.slice(0, 10).split("-");
    return {
      label: `${MONTHS[Number(m) - 1]} ${Number(d)}`,
      value: b.energy_wh / 1000,
    };
  });
  const total = s.series.reduce((n, b) => n + b.energy_wh, 0);
  return (
    <figure className="card report-chart" aria-labelledby="trend-heading">
      <div className="chead">
        <h2 id="trend-heading">Energy, last 30 days (kWh)</h2>
        <span className="muted">
          {s.time_zone} · <Link href="/reports">Reports</Link>
        </span>
      </div>
      {total === 0 ? (
        <p className="muted">No sessions in the last 30 days yet.</p>
      ) : (
        <BarChart
          bars={bars}
          summary={`Energy by day for the last 30 days, ${formatKwh(whToKwh(total))} in total; Reports has the same figures as a table`}
          unit="kWh"
        />
      )}
    </figure>
  );
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

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
