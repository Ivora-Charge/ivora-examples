import type { State } from "./types";
import { StatusChip } from "./timeline";
import { clock, statusOf } from "@/lib/timeline";

/** Wall display for a TV: big numbers, the next departures, no scrolling at 1280x720 or 1920x1080. */
export default function Wall({
  s,
  onExit,
  error,
}: {
  s: State;
  onExit: () => void;
  error?: string;
}) {
  const cap = s.settings.siteCapKw;
  const used = cap > 0 ? Math.min(100, (s.totalKw / cap) * 100) : 0;
  const count = { ready: 0, charging: 0, waiting: 0, late: 0, away: 0 };
  for (const r of s.rows) count[statusOf(r)]++;
  const next = s.rows
    .filter((r) => r.vehicle.departure && !r.departed)
    .sort(
      (a, b) =>
        Date.parse(a.vehicle.departure!) - Date.parse(b.vehicle.departure!),
    )
    .slice(0, 6);
  const left = s.rows.filter((r) => r.departed).length;
  const tiles = [
    ["ready", "Ready", count.ready],
    ["charging", "Charging", count.charging],
    ["waiting", "Waiting", count.waiting],
    ["late", "At risk", count.late],
  ] as const;
  return (
    <main id="main" className="tvmode wall">
      <header className="top">
        <h1>Depot overview</h1>
        {s.demo && <span className="demotag">Demo</span>}
        {s.tz && <span className="tzlab">Depot time</span>}
        <span className="num clock">
          {clock(s.sim?.at ?? Date.parse(s.now), s.tz)}
        </span>
        <button onClick={onExit}>Exit wall display (Esc)</button>
      </header>
      <div className="wallgrid">
        <section className="panel wallpower" aria-labelledby="wp-h">
          <h2 id="wp-h">Site power</h2>
          <p className="wallkw num">
            {s.totalKw.toFixed(0)} <small>of {cap} kW cap</small>
          </p>
          <div
            className="meter slim"
            role="img"
            aria-label={`${s.totalKw.toFixed(1)} kW of the ${cap} kW site cap, ${used.toFixed(0)}%`}
          >
            <i style={{ width: `${used}%` }} />
          </div>
          {s.sim && (
            <p className="num wallpeak">
              Peak {s.sim.peakKw.toFixed(0)} kW vs{" "}
              {s.sim.ghostPeakKw.toFixed(0)} kW unmanaged
            </p>
          )}
          <dl className="walltiles">
            {tiles.map(([k, label, n]) => (
              <div key={k} className={`tile ${k}`}>
                <dt>
                  <StatusChip status={k} />
                  <span className="sr">{label}</span>
                </dt>
                <dd className="num">{n}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="panel flush wallnext" aria-labelledby="wn-h">
          <h2 id="wn-h">Next departures</h2>
          {next.length === 0 ? (
            <p className="empty">
              {left > 0
                ? `All vehicles have left: ${s.rows.filter((r) => r.departed?.ready).length} of ${s.rows.length} left ready.`
                : "No vehicles in the depot yet."}
            </p>
          ) : (
            <ul className="nextlist">
              {next.map((r) => (
                <li key={r.vehicle.id}>
                  <b>{r.vehicle.name}</b>
                  <span className="num">
                    {clock(Date.parse(r.vehicle.departure!), s.tz)}
                  </span>
                  <span className="num">
                    {r.soc !== undefined ? `${r.soc.toFixed(0)}% now` : "-"}
                  </span>
                  <StatusChip status={statusOf(r)} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {error && (
        <p className="msg warn" role="alert">
          {error}. The figures may be out of date.
        </p>
      )}
    </main>
  );
}
