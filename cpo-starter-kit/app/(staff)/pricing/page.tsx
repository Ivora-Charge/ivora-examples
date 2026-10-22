import Link from "next/link";
import { requireRole } from "@/lib/server/auth";
import { config } from "@/lib/server/env";
import { MAX_LIST_PAGES } from "@/lib/server/ivora/live";
import { getPricing, loadPricing } from "@/lib/server/pricing";
import { resetDemoPricingAction } from "./actions";
import { StationPricingForm } from "./forms";
import { Loading } from "@/app/loading-skeleton";

export const metadata = { title: "Pricing" };

async function Content() {
  // Owners and managers only: prices decide what drivers pay.
  const me = await requireRole("manager");
  const r = await loadPricing(getPricing(), me);
  const assignable = r.tariffs
    .filter((t) => t.current)
    .map((t) => ({ id: t.id, name: t.name }));
  return (
    <>
      <h1>Pricing</h1>
      <section className="card" aria-labelledby="tariffs-heading">
        <h2 id="tariffs-heading">
          Tariffs
          {me.demo && <span className="badge">Sample</span>}
        </h2>
        <p className="muted">
          Each change saves a new version in Ivora. Bills keep the price they
          were made with; new sessions use the newest version.
        </p>
        {r.tariffs.length === 0 ? (
          <p className="muted">No tariffs yet.</p>
        ) : (
          <ul className="rows" aria-label="Tariffs">
            {r.tariffs.map((t) => (
              <li key={t.id}>
                <Link className="name" href={`/pricing/${t.id}`}>
                  {t.name}
                </Link>
                <span className="muted">
                  {[
                    t.summary,
                    t.current ? `version ${t.current.version}` : null,
                    `${t.connectors} ${t.connectors === 1 ? "connector" : "connectors"}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {t.needsFinishing ? (
                  <span className="pill off">Not confirmed by Ivora</span>
                ) : t.definition?.kind === "free" ? (
                  <span className="pill ok">Free</span>
                ) : (
                  <span className="pill ok">Live</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p>
          <Link className="button" href="/pricing/new">
            New tariff
          </Link>
        </p>
      </section>

      <section className="card" aria-labelledby="stations-heading">
        <h2 id="stations-heading">Which tariff each connector uses</h2>
        <p className="muted">
          Give a charger a tariff, and a connector its own where it differs. The
          kit&apos;s driver checkout (a later part) bills each connector with
          its tariff; a connector without one is not for sale. Private chargers
          have no public QR checkout: staff and RFID only.
          {config.fleetModule && (
            <>
              {" "}
              Your RFID cards are in <Link href="/cards">Cards</Link>.
            </>
          )}
        </p>
        {r.stationsError ? (
          <p className="error" role="alert">
            {r.stationsError}
          </p>
        ) : r.stations.length === 0 ? (
          <p className="muted">
            No chargers yet. <Link href="/chargers">Add one</Link>.
          </p>
        ) : (
          <>
            {r.truncated && (
              <p className="notice" role="note">
                Showing the first{" "}
                {(MAX_LIST_PAGES * 100).toLocaleString("en-US")} chargers.
              </p>
            )}
            <ul className="rows" aria-label="Chargers and their tariffs">
              {r.stations.map((s) => (
                <li key={s.stationId} className="pricing-station">
                  <span className="name">{s.name}</span>
                  <span className="muted">{s.siteName ?? "No site"}</span>
                  {s.private && <span className="badge">Private</span>}
                  <ul className="connector-tariffs">
                    {s.connectors.map((c) => (
                      <li key={c.id}>
                        Connector {c.number}:{" "}
                        {c.tariffName ? (
                          <strong>{c.tariffName}</strong>
                        ) : (
                          <span>no tariff</span>
                        )}
                        {c.source === "station" && (
                          <span className="muted"> (the charger&apos;s)</span>
                        )}
                        {c.source === "connector" && (
                          <span className="muted"> (its own)</span>
                        )}
                        {c.ivoraTariffId !== null && (
                          <span className="muted">
                            {" "}
                            · charger screen price: Ivora tariff{" "}
                            {c.ivoraTariffId}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <details className="command">
                    <summary className="button secondary">Change</summary>
                    <StationPricingForm
                      stationId={s.stationId}
                      stationName={s.name}
                      revision={s.revision}
                      tariffId={s.tariffId}
                      private={s.private}
                      connectors={s.connectors.map((c) => ({
                        id: c.id,
                        number: c.number,
                        override: c.override,
                      }))}
                      tariffs={assignable}
                    />
                  </details>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      {me.demo && (
        <form action={resetDemoPricingAction} className="demo-sim">
          <button type="submit" className="button secondary">
            Demo: reset prices to the samples
          </button>
        </form>
      )}
    </>
  );
}

/** The page behind its loading skeleton. */
export default function Page() {
  return (
    <Loading shape="list">
      <Content />
    </Loading>
  );
}
