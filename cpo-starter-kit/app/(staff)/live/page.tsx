import Link from "next/link";
import { atLeast } from "@/lib/roles";
import { requireRole } from "@/lib/server/auth";
import { checkoutAlerts, getCheckout } from "@/lib/server/checkout";
import { config } from "@/lib/server/env";
import { MAX_LIST_PAGES } from "@/lib/server/ivora/live";
import { getLive, loadLive } from "@/lib/server/live";
import { formatKwh } from "@/lib/units";
import { resetDemoLiveAction } from "./actions";
import { CommandsCard } from "./commands";
import LiveMap from "./map";
import { Refresher } from "./refresher";
import { ConnectorPill, StatePill, when } from "./status";
import { Loading } from "@/app/loading-skeleton";

export const metadata = { title: "Live" };

async function Content() {
  const me = await requireRole("viewer");
  const canWork = atLeast(me.role, "technician");
  const r = await loadLive(getLive(), me);
  if (!r.ok)
    return (
      <>
        <h1>Live</h1>
        <Refresher
          readAt={new Date().toISOString()}
          webhooks={Boolean(config.webhookSecret)}
          pending={false}
          retryAfter={r.retryAfter}
        />
        <p className="error" role="alert">
          {r.error}
        </p>
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
  return (
    <>
      <h1>Live</h1>
      <Refresher
        readAt={live.readAt}
        webhooks={!demo && Boolean(config.webhookSecret)}
        pending={pending}
        retryAfter={live.retryAfter}
      />
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

      <section className="stats" aria-label="Live summary">
        <Stat
          label="Chargers online"
          value={`${live.counts.online} / ${live.counts.stations}`}
        />
        <Stat label="Offline" value={live.counts.offline} />
        <Stat label="Faulted" value={live.counts.faulted} />
        <Stat label="Charging now" value={live.counts.charging} />
        <Stat label="Connectors" value={live.counts.connectors} />
      </section>

      {live.points.length > 0 && (
        <section className="card" aria-labelledby="map-heading">
          <h2 id="map-heading">
            Map
            {demo && <span className="badge">Sample</span>}
          </h2>
          <LiveMap sites={live.points} tiles={tiles} />
          {demo ? (
            <p className="muted">
              Demo: no map tiles are loaded, so the demo stays offline. Live
              mode shows OpenStreetMap.
            </p>
          ) : (
            !tiles && (
              <p className="muted">
                Map tiles are off (MAP_TILE_URL). The markers still show each
                site.
              </p>
            )
          )}
        </section>
      )}

      <section className="card" aria-labelledby="sites-heading">
        <h2 id="sites-heading">
          Sites and chargers
          {demo && <span className="badge">Sample</span>}
        </h2>
        {live.sites.length === 0 ? (
          <p className="muted">
            No chargers yet. <Link href="/chargers">Add one</Link>.
          </p>
        ) : (
          live.sites.map((s) => (
            <div key={s.id ?? "none"} className="site">
              <h3 id={s.id !== null ? `site-${s.id}` : undefined}>
                {s.name}
                {s.address && <span className="muted"> · {s.address}</span>}
              </h3>
              <ul className="rows" aria-label={`Chargers at ${s.name}`}>
                {s.stations.map((st) => (
                  <li key={st.id}>
                    <Link className="name" href={`/live/stations/${st.id}`}>
                      {st.name}
                    </Link>
                    <span className="connectors">
                      {st.connectors.map((c) => (
                        <span key={c.id} className="connector">
                          <span className="muted">{c.number}</span>
                          <ConnectorPill status={c.status} />
                        </span>
                      ))}
                    </span>
                    {st.openFaults > 0 && (
                      <span className="muted">
                        {st.openFaults} open{" "}
                        {st.openFaults === 1 ? "fault" : "faults"}
                      </span>
                    )}
                    <StatePill state={st.state} />
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

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

      {!canWork && (
        <p className="muted">
          Viewers see the live state. Technicians, managers and owners can
          start, stop, reset and unlock chargers.
        </p>
      )}
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

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

/** The page behind its loading skeleton. */
export default function Page() {
  return (
    <Loading shape="stats">
      <Content />
    </Loading>
  );
}
