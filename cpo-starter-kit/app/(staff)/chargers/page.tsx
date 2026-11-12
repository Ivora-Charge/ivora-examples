import Link from "next/link";
import { atLeast } from "@/lib/roles";
import { requireRole } from "@/lib/server/auth";
import { getChargers, loadChargers } from "@/lib/server/chargers";
import { MAX_LIST_PAGES } from "@/lib/server/ivora/live";
import { resetDemoChargersAction } from "./actions";
import { AddChargerForm } from "./forms";
import { StatusPill, When } from "./status";
import { companyZone } from "./zone";
import { DataTable, type DataTableRow } from "@/app/ui/data-table";
import { EmptyState } from "@/app/ui/empty-state";
import { PageHeader } from "@/app/ui/page-header";
import { SummaryStrip } from "@/app/ui/summary-strip";
import {
  chargerCounts,
  chargerStatusText,
  chargerZone,
  freeConnectorCount,
} from "@/lib/charger-table";
import type { ChargersResult } from "@/lib/server/chargers";
import { Loading } from "@/app/loading-skeleton";

export const metadata = { title: "Chargers" };

type Loaded = Extract<ChargersResult, { ok: true }>;

function description(r: ChargersResult, demo: boolean) {
  if (!r.ok) return undefined;
  const sites = new Set(r.chargers.map((c) => c.siteName).filter(Boolean));
  const n = r.chargers.length;
  const sample = demo ? " Sample data." : "";
  if (n === 0) return `No chargers yet.${sample}`;
  return `${n} ${n === 1 ? "charger" : "chargers"}${sites.size ? ` at ${sites.size} ${sites.size === 1 ? "site" : "sites"}` : ""}.${sample}`;
}

function ChargersTable({
  r,
  canWork,
  company,
}: {
  r: Loaded;
  canWork: boolean;
  company: string | null;
}) {
  const counts = chargerCounts(r.chargers);
  const siteZone = new Map(r.sites.map((s) => [s.id, s.time_zone]));
  const rows: DataTableRow[] = r.chargers.map((c) => {
    const free = freeConnectorCount(c);
    return {
      id: c.key,
      values: {
        charger: c.label,
        id: c.name,
        site: c.siteName ?? "No site",
        status: chargerStatusText(c),
        free: c.connectors.length ? free : -1,
        seen: c.lastSeen ?? "",
      },
      cells: {
        charger: (
          <span className="cell-stack">
            <Link className="name" href={`/chargers/${c.key}`}>
              {c.label}
            </Link>
            {c.label !== c.name && <span className="muted">{c.name}</span>}
          </span>
        ),
        status: <StatusPill c={c} />,
        free: c.connectors.length ? (
          `${free} of ${c.connectors.length}`
        ) : (
          <span className="muted">None reported</span>
        ),
        seen: (
          <When
            iso={c.lastSeen}
            zone={chargerZone(
              c.locationId !== null ? siteZone.get(c.locationId) : null,
              company,
            )}
          />
        ),
      },
    };
  });
  return (
    <>
      {r.chargers.length > 0 && (
        <SummaryStrip
          label="Chargers at a glance"
          items={[
            {
              label: "Online",
              value: counts.online,
              unit: `of ${counts.total}`,
            },
            { label: "Connectors", value: counts.connectors },
            { label: "Needs attention", value: counts.attention },
          ]}
        />
      )}
      <DataTable
        caption="Chargers"
        emptyTitle="No chargers yet"
        empty={{
          text: "Add your first charger to see it here. You need its ID; the next step creates the connection password for you.",
          action: canWork ? (
            <a className="button" href="#add-heading">
              Add your first charger
            </a>
          ) : undefined,
        }}
        columns={[
          { key: "charger", label: "Charger" },
          { key: "id", label: "Connection name", hidden: true },
          { key: "site", label: "Site", filter: true, allLabel: "All sites" },
          {
            key: "status",
            label: "Status",
            filter: true,
            allLabel: "All statuses",
          },
          { key: "free", label: "Connectors free", numeric: true },
          { key: "seen", label: "Last message" },
        ]}
        rows={rows}
      />
    </>
  );
}

async function Content({
  searchParams,
}: {
  searchParams: Promise<{ removed?: string | string[] }>;
}) {
  const me = await requireRole("viewer");
  const canWork = atLeast(me.role, "technician");
  const [r, company] = await Promise.all([
    loadChargers(getChargers(), me),
    companyZone(me.operatorId),
  ]);
  const removed = (await searchParams).removed;
  return (
    <>
      <PageHeader
        title="Chargers"
        description={description(r, me.demo)}
        action={
          canWork && r.ok ? (
            <a className="button" href="#add-heading">
              Add charger
            </a>
          ) : undefined
        }
      />
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
        <div className="card">
          <EmptyState
            tone="error"
            title="Chargers did not load"
            action={
              <>
                <Link className="button" href="/chargers">
                  Try again
                </Link>
                <Link href="/settings">Check your settings</Link>
              </>
            }
          >
            {r.error} Nothing was changed.
          </EmptyState>
        </div>
      ) : (
        <>
          {r.truncated && (
            <p className="notice" role="note">
              Showing the first {(MAX_LIST_PAGES * 100).toLocaleString("en-US")}{" "}
              sites and chargers.
            </p>
          )}
          <ChargersTable r={r} canWork={canWork} company={company} />
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

/** Checks the role first (a real redirect), then the page behind its loading skeleton. */
export default async function Page(props: Parameters<typeof Content>[0]) {
  await requireRole("viewer");
  return (
    <Loading shape="list">
      <Content {...props} />
    </Loading>
  );
}
