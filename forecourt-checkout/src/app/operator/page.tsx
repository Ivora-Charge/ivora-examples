import { ErrorBox } from "@/components/error-box";
import { OperatorNav } from "@/components/operator-nav";
import { formatMoney } from "@/lib/money";
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
  const pct = (bps: number) => `${Number((bps * 0.01).toFixed(3))}%`;
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
          Chargers
          <b>
            {data.stations.online}/{data.stations.total} online
          </b>
          <span className="muted">
            {data.stations.faulted} faulted, {data.stations.offline} offline
          </span>
        </div>
      </div>
      {data.totals.length > 1 ? (
        <p className="notice">
          Mixed currencies: totals are shown separately for each currency and
          are never added together.
        </p>
      ) : null}
      {data.totals.map((t) => (
        <section
          className="grid"
          key={t.currency}
          aria-label={`Totals in ${t.currency}`}
        >
          <div className="stat">
            Billed ({t.currency})
            <b>
              {t.billedCents === null
                ? "—"
                : formatMoney(t.billedCents, t.currency)}
            </b>
            <span className="muted">
              {t.billedCents === null ? "needs billing:read" : "final bills"}
            </span>
          </div>
          <div className="stat">
            Captured ({t.currency})
            <b>{formatMoney(t.capturedCents, t.currency)}</b>
            <span className="muted">card payments</span>
          </div>
          <div className="stat">
            Paid in store ({t.currency})
            <b>{formatMoney(t.inStoreCents, t.currency)}</b>
            <span className="muted">cash or card at the counter</span>
          </div>
          <div className="stat">
            Application fee ({t.currency})
            <b>{formatMoney(t.feeCents, t.currency)}</b>
            <span className="muted">
              {data.chargesFee
                ? `${pct(data.feeBps)} (${data.feeBps} bps)`
                : "no connected account"}
            </span>
          </div>
        </section>
      ))}
      <section className="card">
        <h2>Sessions</h2>
        {data.rows.length === 0 ? (
          <div className="empty">
            <p>No sessions yet today.</p>
            <p className="muted">
              Sessions appear here as soon as a driver starts charging.
            </p>
          </div>
        ) : (
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Table, scrolls sideways"
          >
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
                        : formatMoney(r.billedCents, r.currency)}
                    </td>
                    <td className="num">
                      {formatMoney(r.capturedCents, r.currency)}
                    </td>
                    <td>{r.paidVia === "store" ? "paid in store" : "card"}</td>
                    <td className="num">
                      {formatMoney(r.feeCents, r.currency)}
                    </td>
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
