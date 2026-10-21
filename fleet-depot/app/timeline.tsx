import {
  STATUS_LABEL,
  axisFor,
  chargeSpans,
  clock,
  hourTicks,
  pct,
  statusOf,
} from "@/lib/timeline";
import type { Row, State } from "./types";

export function StatusChip({ status }: { status: keyof typeof STATUS_LABEL }) {
  return (
    <span className={`chip ${status}`}>
      <i className="ic" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

function describe(r: Row, status: string, dep?: number) {
  const where = r.session
    ? `plugged in at ${r.session.station} connector ${r.session.connector}, ${r.session.allocatedKw.toFixed(1)} kW, ${r.session.deliveredKwh.toFixed(1)} kWh delivered`
    : "not plugged in";
  const left =
    r.remainingKwh !== undefined
      ? `, ${r.remainingKwh.toFixed(1)} kWh left`
      : "";
  return `${r.vehicle.name}: ${status}, ${where}${left}${dep ? `, departs ${clock(dep)}` : ""}`;
}

/** One vehicle per row on a shared time axis. On phones the axis moves into each row as start, now, departure labels. */
export default function Timeline({ s }: { s: State }) {
  const now = Date.parse(s.now);
  const axis = axisFor(
    now,
    s.rows.map((r) => r.vehicle.departure),
  );
  const rows = [...s.rows].sort(
    (a, b) =>
      (a.vehicle.departure ? Date.parse(a.vehicle.departure) : Infinity) -
      (b.vehicle.departure ? Date.parse(b.vehicle.departure) : Infinity),
  );
  const ticks = hourTicks(axis);
  if (rows.length === 0)
    return (
      <p className="empty">
        No vehicles in the depot yet. They appear here once a vehicle is
        registered in the depot data.
      </p>
    );
  return (
    <>
      <div className="tl-head" aria-hidden="true">
        <span>Vehicle</span>
        <span className="hours">
          {ticks.map((t) => (
            <span key={t} style={{ left: `${pct(t, axis)}%` }}>
              {clock(t)}
            </span>
          ))}
        </span>
        <span className="right">Departs</span>
        <span>Status</span>
      </div>
      <ul className="tl-rows">
        {rows.map((r) => {
          const status = statusOf(r);
          const dep = r.vehicle.departure
            ? Date.parse(r.vehicle.departure)
            : undefined;
          const { done, plan } = r.session
            ? chargeSpans(now, axis, r.session, r.remainingKwh)
            : { done: undefined, plan: undefined };
          return (
            <li className="row" key={r.vehicle.id}>
              <div className="v">
                <b>{r.vehicle.name}</b>
                <span className="num">{r.vehicle.plate}</span>
                {r.driver && <span>{r.driver}</span>}
                <span className="num conn">
                  {r.session
                    ? `${r.session.station} / ${r.session.connector}`
                    : "not plugged in"}
                </span>
              </div>
              <div
                className="track"
                role="img"
                aria-label={describe(r, STATUS_LABEL[status], dep)}
              >
                {ticks.map((t) => (
                  <i
                    className="grid"
                    key={t}
                    style={{ left: `${pct(t, axis)}%` }}
                  />
                ))}
                {done && (
                  <i
                    className={`bar ${status === "ready" ? "ready" : "done"}`}
                    style={{ left: `${done.left}%`, width: `${done.width}%` }}
                  />
                )}
                {plan && (
                  <i
                    className={`bar ${status === "late" ? "late" : "plan"}`}
                    style={{ left: `${plan.left}%`, width: `${plan.width}%` }}
                  />
                )}
                <i className="now" style={{ left: `${pct(now, axis)}%` }} />
                {dep && (
                  <i className="dep" style={{ left: `${pct(dep, axis)}%` }} />
                )}
              </div>
              <div className="tl-lab" aria-hidden="true">
                <span style={{ left: 0 }}>start {clock(axis.start)}</span>
                <span className="n" style={{ left: `${pct(now, axis)}%` }}>
                  now {clock(now)}
                </span>
                {dep && (
                  <span className="d" style={{ left: `${pct(dep, axis)}%` }}>
                    dep {clock(dep)}
                  </span>
                )}
              </div>
              <div className="right num dep-time">
                {dep ? (
                  <>
                    {clock(dep)}
                    {r.soc !== undefined && (
                      <small>
                        {r.soc.toFixed(0)}%{r.socReported ? "" : " est."}
                      </small>
                    )}
                  </>
                ) : (
                  "-"
                )}
              </div>
              <div className="st">
                <StatusChip status={status} />
                {r.session && (
                  <small className="num">
                    {r.session.allocatedKw.toFixed(1)} kW
                  </small>
                )}
                {r.session?.profile && (
                  <small title={r.session.profile.detail}>
                    {r.session.profile.status}
                    {r.session.profile.composite
                      ? ` (${r.session.profile.composite})`
                      : ""}
                  </small>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <ul className="legend" aria-label="Legend">
        <li>
          <i className="sw done" />
          energy delivered
        </li>
        <li>
          <i className="sw plan" />
          planned charge
        </li>
        <li>
          <i className="sw dep" />
          departure
        </li>
        <li>
          <i className="sw now" />
          now
        </li>
      </ul>
    </>
  );
}
