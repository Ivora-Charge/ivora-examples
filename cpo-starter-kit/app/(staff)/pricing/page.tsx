import Link from "next/link";
import { notFound } from "next/navigation";
import { HOST_ROLE } from "@/lib/roles";
import { requireNetworkReader, requireRole } from "@/lib/server/auth";
import type { Staff } from "@/lib/server/team";
import { config } from "@/lib/server/env";
import { MAX_LIST_PAGES } from "@/lib/server/ivora/live";
import { getPricing, loadPricing } from "@/lib/server/pricing";
import { resetDemoPricingAction } from "./actions";
import { StationPricingForm } from "./forms";
import { Loading } from "@/app/loading-skeleton";
import { EmptyState } from "@/app/ui/empty-state";
import { DataTable, type DataTableRow } from "@/app/ui/data-table";
import { PageHeader } from "@/app/ui/page-header";
import { Chip } from "@/app/ui/status-chip";
import {
  tariffEnergy,
  tariffIdle,
  tariffState,
  tariffType,
} from "@/lib/tariff-table";

export const metadata = { title: "Pricing" };

/**
 * Owners and managers: prices decide what drivers pay. A host user only while the
 * operator lets their host edit prices, for the chargers at its own sites; anyone else
 * on a host gets 404.
 */
async function pricingUser(): Promise<Staff> {
  const me = await requireNetworkReader();
  if (me.role !== HOST_ROLE) return requireRole("manager");
  if (!me.host?.permissions.editPrices) notFound();
  return me;
}

async function Content() {
  const me = await pricingUser();
  const hostView = me.role === HOST_ROLE;
  const r = await loadPricing(getPricing(), me);
  const assignable = r.tariffs
    .filter((t) => t.current)
    .map((t) => ({ id: t.id, name: t.name }));
  return (
    <>
      <PageHeader
        title="Pricing"
        description={
          <>
            What drivers pay. A change makes a new price from now on; sessions
            already running keep theirs. Each change saves a new version in
            Ivora, and bills keep the price they were made with.
            {hostView &&
              ` ${me.host?.name}: choose from the operator's tariffs for the chargers at your sites.`}
            {me.demo && " Sample data."}
          </>
        }
        action={
          hostView ? undefined : (
            <Link className="button" href="/pricing/new">
              New tariff
            </Link>
          )
        }
      />
      {!hostView && (
        <>
          <h2 id="tariffs-heading" className="visually-hidden">
            Tariffs
          </h2>
          <DataTable
            caption="Tariffs"
            emptyTitle="No prices yet"
            empty={{
              text: "Create one so drivers can pay. A free price needs no card.",
              action: (
                <Link className="button" href="/pricing/new">
                  Create your first tariff
                </Link>
              ),
            }}
            columns={[
              { key: "name", label: "Name" },
              {
                key: "type",
                label: "Type",
                filter: true,
                allLabel: "All types",
              },
              { key: "energy", label: "Per kWh", numeric: true },
              { key: "idle", label: "Idle fee", numeric: true },
              { key: "connectors", label: "Connectors", numeric: true },
              {
                key: "state",
                label: "State",
                filter: true,
                allLabel: "All states",
              },
            ]}
            rows={r.tariffs.map((t): DataTableRow => {
              const chip = tariffState(t);
              return {
                id: t.id,
                values: {
                  name: t.name,
                  type: tariffType(t.definition),
                  energy: tariffEnergy(t.definition),
                  idle: tariffIdle(t.definition),
                  connectors: t.connectors,
                  state: chip.label,
                },
                cells: {
                  name: (
                    <span className="cell-stack">
                      <Link className="name" href={`/pricing/${t.id}`}>
                        {t.name}
                      </Link>
                      {t.current && (
                        <span className="muted">
                          version {t.current.version}
                        </span>
                      )}
                    </span>
                  ),
                  state: <Chip spec={chip} />,
                },
              };
            })}
          />
        </>
      )}

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
          <EmptyState title="Chargers could not be loaded" tone="error">
            {r.stationsError} Your prices are unchanged. Reload the page to try
            again.
          </EmptyState>
        ) : r.stations.length === 0 ? (
          <EmptyState
            title="No chargers yet"
            action={
              <Link className="button" href="/chargers">
                Add a charger
              </Link>
            }
          >
            Add a charger, then give it a tariff here.
          </EmptyState>
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
      {me.demo && !hostView && (
        <form action={resetDemoPricingAction} className="demo-sim">
          <button type="submit" className="button secondary">
            Demo: reset prices to the samples
          </button>
        </form>
      )}
    </>
  );
}

/** Checks the role first (a real redirect), then the page behind its loading skeleton. */
export default async function Page() {
  await pricingUser();
  return (
    <Loading shape="list">
      <Content />
    </Loading>
  );
}
