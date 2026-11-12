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
  parseLiveId,
  type LiveFilter,
} from "@/lib/live-table";
import { companyZone } from "../chargers/zone";
import { resetDemoLiveAction } from "./actions";
import { CommandsCard } from "./commands";
import LiveMap from "./map";
import { Refresher } from "./refresher";
import { StatePill, when } from "./status";
import { ChargerPanel } from "./charger-panel";
import { DataTable, type DataTableRow } from "@/app/ui/data-table";
import { EmptyState } from "@/app/ui/empty-state";
import { PageHeader } from "@/app/ui/page-header";
import { SummaryStrip } from "@/app/ui/summary-strip";
import { Loading } from "@/app/loading-skeleton";

export const metadata = { title: "Live" };

type Search = {
  status?: string | string[];
  charger?: string | string[];
  site?: string | string[];
};

const TITLE = "Live";
const DESCRIPTION =
  "Chargers, connectors and faults right now. Updates as they happen.";

async function Content({ search }: { search: Search }) {
  const me = await requireRole("viewer");
  const canWork = atLeast(me.role, "technician");
  const [r, zone] = await Promise.all([
    loadLive(getLive(), me),
    companyZone(me.operatorId),
  ]);
  if (!r.ok)
    return (
      <>
        <PageHeader title={TITLE} description={DESCRIPTION} />
        <Refresher
          readAt={new Date().toISOString()}
          zone={zone}
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
  const chargerId = parseLiveId(search.charger);
  // A map marker narrows the table to its site.
  const site =
    live.sites.find(
      (s) => s.id !== null && s.id === parseLiveId(search.site),
    ) ?? null;
  const siteId = site?.id ?? null;
  const selected = all.find((x) => x.st.id === chargerId) ?? null;
  const needAttention = all.filter((x) => x.st.state !== "online");
  const rows: DataTableRow[] = all
    .filter(
      (x) =>
        matchesLiveFilter(x.st, filter) &&
        (siteId === null || x.st.siteId === siteId),
    )
    .map(({ st, site }) => {
      const kwh = st.sessions.reduce((n, x) => n + x.energyKwh, 0);
      const free = freeConnectors(st);
      return {
        id: String(st.id),
        values: {
          charger: st.name,
          site,
          status: st.state,
          free,
          energy: kwh,
        },
        cells: {
          // The site sits under the name, so the table fits beside the map.
          charger: (
            <span className="cell-stack">
              <Link className="name" href={`/live/stations/${st.id}`}>
                {st.name}
              </Link>
              <span className="muted">{site}</span>
            </span>
          ),
          status: (
            <span className="cell-stack">
              <StatePill state={st.state} />
              {st.openFaults > 0 && (
                <span className="muted">
                  {st.openFaults} open{" "}
                  {st.openFaults === 1 ? "fault" : "faults"}
                </span>
              )}
            </span>
          ),
          free:
            st.connectors.length === 0 ? (
              <span className="muted">None reported</span>
            ) : (
              `${free} of ${st.connectors.length}`
            ),
          energy: st.sessions.length ? formatKwh(kwh) : "—",
          select: (
            <Link
              className="button secondary"
              href={`${liveHref(filter, st.id, siteId)}#charger-panel`}
              aria-label={`Remote actions for ${st.name}`}
              aria-current={st.id === chargerId ? "true" : undefined}
            >
              {st.id === chargerId ? "Selected" : "Actions"}
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
    href: liveHref(x.filter, chargerId, siteId),
    active: filter === x.filter,
  }));

  return (
    <>
      <PageHeader title={TITLE} description={DESCRIPTION} />
      <Refresher
        readAt={live.readAt}
        zone={zone}
        webhooks={!demo && Boolean(config.webhookSecret)}
        pending={pending}
        retryAfter={live.retryAfter}
      />
      {needAttention.length > 0 && (
        // role="status": announced politely, and only when the text changes, not on
        // every refresh.
        <div className="error fault-banner" role="status">
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
            href={`${liveHref(filter, needAttention[0].st.id, siteId)}#charger-panel`}
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
          <div className="live-list" id="chargers" tabIndex={-1}>
            <h2 className="visually-hidden">
              Chargers
              {demo ? " (sample)" : ""}
            </h2>
            {site && (
              <p className="notice site-scope" role="note">
                <span>
                  Showing chargers at <strong>{site.name}</strong>.
                </span>
                <Link href={`${liveHref(filter, chargerId)}#chargers`}>
                  Show all sites
                </Link>
              </p>
            )}
            <DataTable
              caption="Chargers"
              emptyTitle="No chargers match"
              columns={[
                { key: "charger", label: "Charger" },
                {
                  key: "site",
                  label: "Site",
                  filter: true,
                  hidden: true,
                  allLabel: "All sites",
                },
                { key: "status", label: "Status", noSearch: true },
                {
                  key: "free",
                  label: "Free",
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
                    ? site
                      ? "No chargers at this site."
                      : "No chargers to show."
                    : site
                      ? "No charger at this site has this status right now."
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
                  {demo && (
                    <span
                      className="badge"
                      title="Sample map: the demo loads no map tiles, so it stays offline. Live mode shows OpenStreetMap."
                    >
                      Sample
                    </span>
                  )}
                </h2>
                <LiveMap
                  sites={live.points.map((p) => ({
                    ...p,
                    href: `${liveHref(filter, chargerId, p.id)}#chargers`,
                  }))}
                  tiles={tiles}
                  sample={demo}
                />
                <p className="muted sm">
                  Marker shape repeats the status: circle online, triangle
                  fault, square offline. Select a marker to show that
                  site&apos;s chargers; the table has the same information.
                </p>
                {!demo && !tiles && (
                  <p className="muted sm">
                    Map tiles are off (MAP_TILE_URL). The markers still show
                    each site.
                  </p>
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
