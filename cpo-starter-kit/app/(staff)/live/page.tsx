import Link from "next/link";
import { atLeast } from "@/lib/roles";
import { requireRole } from "@/lib/server/auth";
import { checkoutAlerts, getCheckout } from "@/lib/server/checkout";
import { config } from "@/lib/server/env";
import { MAX_LIST_PAGES } from "@/lib/server/ivora/live";
import { getLive, loadLive } from "@/lib/server/live";
import { formatKwh } from "@/lib/units";
import {
  freeConnectors,
  liveHref,
  matchesLiveFilter,
  parseLiveFilter,
  type LiveFilter,
} from "@/lib/live-table";
import { resetDemoLiveAction } from "./actions";
import { CommandsCard } from "./commands";
import LiveMap from "./map";
import { Refresher } from "./refresher";
import { ConnectorPill, StatePill, when } from "./status";
import { ChargerPanel } from "./charger-panel";
import { DataTable, type DataTableRow } from "@/app/ui/data-table";
import { EmptyState } from "@/app/ui/empty-state";
import { PageHeader } from "@/app/ui/page-header";
import { SummaryStrip } from "@/app/ui/summary-strip";
import { Loading } from "@/app/loading-skeleton";

export const metadata = { title: "Live" };

type Search = { status?: string | string[]; charger?: string | string[] };

const TITLE = "Live";
const DESCRIPTION =
  "Chargers, connectors and faults right now. Updates as they happen.";

async function Content({ search }: { search: Search }) {
  const me = await requireRole("viewer");
  const canWork = atLeast(me.role, "technician");
  const r = await loadLive(getLive(), me);
  if (!r.ok)
    return (
      <>
        <PageHeader title={TITLE} description={DESCRIPTION} />
        <Refresher
          readAt={new Date().toISOString()}
          webhooks={Boolean(config.webhookSecret)}
          pending={false}
          retryAfter={r.retryAfter}
        />
        <div className="card">
          <EmptyState
            tone="error"
            title="Live data is not reaching us"
            action={
              <>
                <Link className="button" href="/live">
                  Try again
                </Link>
                <Link href="/settings">Check your settings</Link>
              </>
            }
          >
            {r.error} Chargers and sessions are not affected.
          </EmptyState>
        </div>
      </>
    );
  const live = r.live;
  // Driver checkouts that need the operator. A failed read doesn't hide the rest.
  const alerts = await checkoutAlerts(getCheckout(), me.operatorId).catch(
    () => null,
  );
  const stationName = (id: number) =>
    live.sites.flatMap((s) => s.stations).find((s) => s.id === id)?.name ??
    `Charger ${id}`;
  const demo = live.mode === "demo";
  // Demo mode loads no map tiles, so it stays offline.
  const tiles = demo ? null : config.mapTiles;
  const pending = live.commands.some((c) => c.phase === "pending");

  const filter: LiveFilter = parseLiveFilter(search.status);
  const all = live.sites.flatMap((s) =>
    s.stations.map((st) => ({ st, site: s.name })),
  );
  const chargerId = /^\d{1,15}$/.test(String(search.charger ?? ""))
    ? Number(search.charger)
    : null;
  const selected = all.find((x) => x.st.id === chargerId) ?? null;
  const needAttention = all.filter((x) => x.st.state !== "online");
  const rows: DataTableRow[] = all
    .filter((x) => matchesLiveFilter(x.st, filter))
    .map(({ st, site }) => {
      const kwh = st.sessions.reduce((n, x) => n + x.energyKwh, 0);
      return {
        id: String(st.id),
        values: {
          charger: st.name,
          site,
          status: st.state,
          free: freeConnectors(st),
          faults: st.openFaults,
          energy: kwh,
        },
        cells: {
          charger: (
            <Link className="name" href={`/live/stations/${st.id}`}>
              {st.name}
            </Link>
          ),
          status: <StatePill state={st.state} />,
          free: (
            <span className="connectors">
              {st.connectors.length === 0 && (
                <span className="muted">None reported</span>
              )}
              {st.connectors.map((c) => (
                <span key={c.id} className="connector">
                  <span className="muted">{c.number}</span>
                  <ConnectorPill status={c.status} />
                </span>
              ))}
            </span>
          ),
          faults: st.openFaults > 0 ? st.openFaults : "None",
          energy: st.sessions.length ? formatKwh(kwh) : "—",
          select: (
            <Link
              className="button secondary"
              href={`${liveHref(filter, st.id)}#charger-panel`}
              aria-label={`Remote actions for ${st.name}`}
              aria-current={st.id === chargerId ? "true" : undefined}
            >
              {st.id === chargerId ? "Selected" : "Select"}
            </Link>
          ),
        },
      };
    });

  const strip = [
    {
      label: "Chargers online",
      value: `${live.counts.online} / ${live.counts.stations}`,
      filter: "all" as const,
    },
    {
      label: "Charging now",
      value: live.counts.charging,
      unit: live.counts.charging === 1 ? "session" : "sessions",
      filter: "charging" as const,
    },
    {
      label: "Faulted",
      value: live.counts.faulted,
      filter: "faulted" as const,
    },
    {
      label: "Offline",
      value: live.counts.offline,
      filter: "offline" as const,
    },
  ].map((x) => ({
    label: x.label,
    value: x.value,
    unit: x.unit,
    href: liveHref(x.filter, chargerId),
    active: filter === x.filter,
  }));

  return (
    <>
      <PageHeader title={TITLE} description={DESCRIPTION} />
      <Refresher
        readAt={live.readAt}
        webhooks={!demo && Boolean(config.webhookSecret)}
        pending={pending}
        retryAfter={live.retryAfter}
      />
      {needAttention.length > 0 && (
        <div className="error fault-banner" role="alert">
          <span>
            <strong>
              {needAttention.length}{" "}
              {needAttention.length === 1 ? "charger needs" : "chargers need"}{" "}
              attention.
            </strong>{" "}
            {needAttention
              .map(
                (x) =>
                  `${x.st.name} is ${x.st.state === "offline" ? "offline" : "faulted"}`,
              )
              .join("; ")}
            .
          </span>
          <Link
            className="button"
            href={`${liveHref(filter, needAttention[0].st.id)}#charger-panel`}
          >
            Open {needAttention[0].st.name}
          </Link>
        </div>
      )}
      {live.truncated && (
        <p className="notice" role="note">
          Showing the first {(MAX_LIST_PAGES * 100).toLocaleString("en-US")}{" "}
          sites and chargers.
        </p>
      )}
      {!live.sessionsComplete && (
        <p className="notice" role="note">
          The list of running sessions may be incomplete: Ivora was slow or
          refused a read, or some chargers haven&apos;t been checked for a few
          minutes. It catches up on the next refreshes.
        </p>
      )}
      {(alerts === null || alerts.length > 0) && (
        <section className="card" aria-labelledby="checkout-alerts-heading">
          <h2 id="checkout-alerts-heading">Driver sessions that need you</h2>
          {alerts === null ? (
            <p className="error" role="alert">
              Driver checkouts can&apos;t be read right now.
            </p>
          ) : (
            <ul className="rows" aria-label="Driver sessions that need you">
              {alerts.map((a) => (
                <li key={a.reference}>
                  <Link className="name" href={`/live/stations/${a.stationId}`}>
                    {stationName(a.stationId)}, sticker {a.stickerCode}
                  </Link>
                  <span>
                    <strong>{a.title}.</strong> {a.detail}
                  </span>
                  <span className="muted">
                    {a.kind === "free" ? "Free session" : "Paid session"} ·
                    since {when(a.createdAt)} · {a.billId ?? a.reference}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <SummaryStrip label="Live summary" items={strip} />

      {live.sites.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No chargers yet"
            action={
              <Link className="button" href="/chargers">
                Add a charger
              </Link>
            }
          >
            Add a charger and it appears here within a minute.
          </EmptyState>
        </div>
      ) : (
        <div className="live-grid">
          <div className="live-list">
            <h2 className="visually-hidden">
              Chargers
              {demo ? " (sample)" : ""}
            </h2>
            <DataTable
              caption="Chargers"
              emptyTitle="No chargers match"
              columns={[
                { key: "charger", label: "Charger" },
                { key: "site", label: "Site", filter: true },
                { key: "status", label: "Status", noSearch: true },
                {
                  key: "free",
                  label: "Connectors",
                  numeric: true,
                  noSearch: true,
                },
                {
                  key: "faults",
                  label: "Open faults",
                  numeric: true,
                  noSearch: true,
                },
                {
                  key: "energy",
                  label: "Energy now",
                  numeric: true,
                  noSearch: true,
                },
                {
                  key: "select",
                  label: "Remote actions",
                  fixed: true,
                  noSearch: true,
                },
              ]}
              rows={rows}
              empty={{
                text:
                  filter === "all"
                    ? "No chargers to show."
                    : "No charger has this status right now.",
                action: (
                  <Link className="button secondary" href="/live">
                    Show all chargers
                  </Link>
                ),
              }}
            />
          </div>
          <div className="live-side">
            {live.points.length > 0 && (
              <section className="card" aria-labelledby="map-heading">
                <h2 id="map-heading">
                  Map
                  {demo && <span className="badge">Sample</span>}
                </h2>
                <LiveMap sites={live.points} tiles={tiles} />
                <p className="muted sm">
                  Marker shape repeats the status: circle online, triangle
                  fault, square offline. The table has the same information.
                </p>
                {demo ? (
                  <p className="muted sm">
                    Demo: no map tiles are loaded, so the demo stays offline.
                    Live mode shows OpenStreetMap.
                  </p>
                ) : (
                  !tiles && (
                    <p className="muted sm">
                      Map tiles are off (MAP_TILE_URL). The markers still show
                      each site.
                    </p>
                  )
                )}
              </section>
            )}
            {selected ? (
              <ChargerPanel
                live={live}
                station={selected.st}
                siteName={selected.site}
                canWork={canWork}
              />
            ) : (
              <section
                className="card charger-panel"
                id="charger-panel"
                aria-labelledby="panel-heading"
              >
                <h2 id="panel-heading">Remote actions</h2>
                <p className="muted">
                  Select a charger in the table to reset it, unlock a connector
                  or start a session. Each action asks you to confirm first.
                </p>
              </section>
            )}
          </div>
        </div>
      )}

      <section className="card" aria-labelledby="sessions-heading">
        <h2 id="sessions-heading">Charging now</h2>
        {live.sessions.length === 0 ? (
          <p className="muted">No sessions running.</p>
        ) : (
          <ul className="rows" aria-label="Sessions running">
            {live.sessions.map((x) => (
              <li key={x.id}>
                <Link className="name" href={`/live/stations/${x.stationId}`}>
                  {x.stationName}
                  {x.connectorNumber ? `, connector ${x.connectorNumber}` : ""}
                </Link>
                <span className="muted">
                  Session {x.id} · since {when(x.startedAt)} ·{" "}
                  {formatKwh(x.energyKwh)}
                  {x.idToken ? ` · token ${x.idToken}` : ""}
                  {x.staff ? " · staff/test session" : ""}
                  {x.free ? " · free session" : ""}
                  {x.stalled ? " · no energy for 12 hours" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="faults-heading">
        <h2 id="faults-heading">Open faults</h2>
        {live.faults.length === 0 ? (
          <p className="muted">No open faults.</p>
        ) : (
          <ul className="rows" aria-label="Open faults">
            {live.faults.map((f) => (
              <li key={f.id}>
                <Link className="name" href={`/live/stations/${f.stationId}`}>
                  {f.stationName}
                  {f.connectorNumber
                    ? `, connector ${f.connectorNumber}`
                    : ", whole charger"}
                </Link>
                <span>
                  {f.errorCode ?? f.status ?? "Fault"}
                  {f.info && <span className="muted"> · {f.info}</span>}
                </span>
                <span className="muted">since {when(f.openedAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted">
          Open a charger for its fault history and to reset it.
        </p>
      </section>

      <CommandsCard commands={live.commands} canWork={canWork} />

      {demo && canWork && (
        <form action={resetDemoLiveAction} className="demo-sim">
          <button type="submit" className="button secondary">
            Demo: reset chargers and commands to the samples
          </button>
        </form>
      )}
    </>
  );
}

/** Checks the role first (a real redirect), then the page behind its loading skeleton. */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireRole("viewer");
  const search = await searchParams;
  return (
    <Loading shape="stats">
      <Content search={search} />
    </Loading>
  );
}
