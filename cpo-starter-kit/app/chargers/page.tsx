import Link from "next/link";
import { atLeast } from "@/lib/roles";
import { requireRole } from "@/lib/server/auth";
import { getChargers, loadChargers } from "@/lib/server/chargers";
import { MAX_LIST_PAGES } from "@/lib/server/ivora/live";
import { resetDemoChargersAction } from "./actions";
import { AddChargerForm } from "./forms";
import { StatusPill } from "./status";

export const metadata = { title: "Chargers" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ removed?: string | string[] }>;
}) {
  const me = await requireRole("viewer");
  const canWork = atLeast(me.role, "technician");
  const r = await loadChargers(getChargers(), me);
  const removed = (await searchParams).removed;
  return (
    <>
      <h1>Chargers</h1>
      {removed === "deleted" && (
        <p className="success" role="status">
          Charger removed, and deleted in Ivora. Its stickers no longer lead to
          it.
        </p>
      )}
      {removed === "hidden" && (
        <p className="success" role="status">
          Charger removed from the kit. Ivora keeps it because it has charging
          history (its sessions stay in your reports); its stickers no longer
          lead to it.
        </p>
      )}
      {!r.ok ? (
        <p className="error" role="alert">
          {r.error}
        </p>
      ) : (
        <>
          {r.truncated && (
            <p className="notice" role="note">
              Showing the first {(MAX_LIST_PAGES * 100).toLocaleString("en-US")}{" "}
              sites and chargers.
            </p>
          )}
          <section className="card" aria-labelledby="list-heading">
            <h2 id="list-heading">
              Your chargers
              {me.demo && <span className="badge">Sample</span>}
            </h2>
            {r.chargers.length === 0 ? (
              <p className="muted">No chargers yet.</p>
            ) : (
              <ul className="rows" aria-label="Chargers">
                {r.chargers.map((c) => (
                  <li key={c.key}>
                    <Link className="name" href={`/chargers/${c.key}`}>
                      {c.label}
                    </Link>
                    <span className="muted">
                      {[
                        c.label !== c.name ? c.name : null,
                        c.siteName,
                        c.connectors.length
                          ? `${c.connectors.length} ${c.connectors.length === 1 ? "connector" : "connectors"}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <StatusPill c={c} />
                  </li>
                ))}
              </ul>
            )}
          </section>
          {canWork ? (
            <section className="card" aria-labelledby="add-heading">
              <h2 id="add-heading">Add a charger</h2>
              <AddChargerForm
                sites={r.sites.map((s) => ({ id: s.id, name: s.name }))}
              />
            </section>
          ) : (
            <p className="muted">
              Viewers can see chargers. Technicians, managers and owners add and
              test them.
            </p>
          )}
          {me.demo && canWork && (
            <form action={resetDemoChargersAction} className="demo-sim">
              <button type="submit" className="button secondary">
                Demo: reset chargers to the samples
              </button>
            </form>
          )}
        </>
      )}
    </>
  );
}
