import { ErrorBox } from "@/components/error-box";
import { OperatorNav } from "@/components/operator-nav";
import { formatCents } from "@/lib/money";
import { errorInfo } from "@/lib/server/http";
import { overview, type Overview } from "@/lib/server/operator";
import { requireOperator } from "@/lib/server/operator-page";
import { formatLocalTime } from "@/lib/time";
import { whToKwhText } from "@/lib/units";

export const dynamic = "force-dynamic";

export default async function Today() {
  const s = await requireOperator();
  let data: Overview;
  try {
    data = await overview(s);
  } catch (error) {
    return (
      <main className="wide">
        <OperatorNav current="today" />
        <ErrorBox
          info={errorInfo(error).body}
          title="Could not load today's figures"
        />
      </main>
    );
  }
  const pct = (bps: number) =>
    `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
  return (
    <main className="wide">
      <OperatorNav current="today" />
      <h1>{data.siteName}: today</h1>
      {data.demo ? (
        <p className="notice">
          Demo data.{" "}
          {s.missing.includes("DEMO_MODE=1") ? (
            <>
              <code>DEMO_MODE=1</code> is set.
            </>
          ) : (
            <>
              Live mode also needs: <code>{s.missing.join(", ")}</code>
            </>
          )}
        </p>
      ) : null}
      <div className="grid">
        <div className="stat">
          Sessions<b>{data.sessions}</b>
          <span className="muted">{data.activeSessions} active</span>
        </div>
        <div className="stat">
          Energy<b>{Number(data.energyKwh).toFixed(1)} kWh</b>
        </div>
        <div className="stat">
          Billed
          <b>
            {data.billedCents === null ? "—" : formatCents(data.billedCents)}
          </b>
          <span className="muted">
            {data.billedCents === null ? "needs billing:read" : "final bills"}
          </span>
        </div>
        <div className="stat">
          Captured<b>{formatCents(data.capturedCents)}</b>
          <span className="muted">card payments</span>
        </div>
        <div className="stat">
          Paid in store<b>{formatCents(data.inStoreCents)}</b>
          <span className="muted">cash or card at the counter</span>
        </div>
        <div className="stat">
          Application fee<b>{formatCents(data.feeCents)}</b>
          <span className="muted">
            {data.chargesFee
              ? `${pct(data.feeBps)} (${data.feeBps} bps)`
              : "no connected account"}
          </span>
        </div>
        <div className="stat">
          Chargers
          <b>
            {data.stations.online}/{data.stations.total} online
          </b>
          <span className="muted">
            {data.stations.faulted} faulted, {data.stations.offline} offline
          </span>
        </div>
      </div>
      <section className="card">
        <h2>Sessions</h2>
        {data.rows.length === 0 ? (
          <p className="muted">No sessions yet today.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Charger</th>
                  <th>Status</th>
                  <th className="num">Energy</th>
                  <th className="num">Billed</th>
                  <th className="num">Paid</th>
                  <th>Via</th>
                  <th className="num">Fee</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.reference}>
                    <td>{formatLocalTime(r.createdAt, s.siteTimeZone)}</td>
                    <td>{r.station}</td>
                    <td>{r.status}</td>
                    <td className="num">{whToKwhText(r.energyWh)} kWh</td>
                    <td className="num">
                      {r.billedCents === null
                        ? "—"
                        : formatCents(r.billedCents)}
                    </td>
                    <td className="num">{formatCents(r.capturedCents)}</td>
                    <td>{r.paidVia === "store" ? "paid in store" : "card"}</td>
                    <td className="num">{formatCents(r.feeCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted">
          Times in {s.siteTimeZone}. Billed is Ivora&apos;s final bill; paid is
          what the card was charged after idle grace and holds, or what the
          cashier recorded as paid in store.
        </p>
      </section>
    </main>
  );
}
