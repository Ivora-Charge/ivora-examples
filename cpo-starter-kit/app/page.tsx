import Link from "next/link";
import { MODULES } from "@/lib/modules";
import { requireRole } from "@/lib/server/auth";
import { MAX_LIST_PAGES } from "@/lib/server/ivora/live";
import { loadOverview } from "@/lib/server/overview";
import { formatKwh } from "@/lib/units";

export const metadata = { title: "Overview" };

export default async function Page() {
  await requireRole("viewer");
  const r = await loadOverview();
  return (
    <>
      <h1>Overview</h1>
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

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
