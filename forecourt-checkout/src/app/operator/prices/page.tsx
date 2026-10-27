import { ErrorBox } from "@/components/error-box";
import { OperatorNav } from "@/components/operator-nav";
import { formatMoney, minorUnitHint } from "@/lib/money";
import { errorInfo } from "@/lib/server/http";
import { pricesPage, type PricesPage } from "@/lib/server/operator";
import { requireOperator } from "@/lib/server/operator-page";
import { ERRORS_URL } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function Prices({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; demo?: string; error?: string }>;
}) {
  const s = await requireOperator();
  const query = await searchParams;
  let data: PricesPage;
  try {
    data = await pricesPage(s);
  } catch (error) {
    return (
      <main className="wide">
        <OperatorNav current="prices" />
        <ErrorBox info={errorInfo(error).body} title="Could not load prices" />
      </main>
    );
  }
  return (
    <main className="wide">
      <OperatorNav current="prices" />
      <h1>Prices per charger</h1>
      {query.saved ? (
        <p className="notice">
          Saved. New sessions use the new prices; sessions already running keep
          theirs.
        </p>
      ) : null}
      {query.demo ? (
        <p className="notice">Demo mode: prices are not saved.</p>
      ) : null}
      {query.error ? (
        <ErrorBox
          info={{
            error: query.error,
            message: "The prices were not saved.",
            docs: query.error === "invalid_prices" ? null : ERRORS_URL,
          }}
        />
      ) : null}
      {data.tariffs.map(({ tariff, lines, form, usedBy }) => {
        const unit = minorUnitHint(tariff.currency);
        return (
          <section className="card" key={tariff.id}>
            <h2>
              Tariff {tariff.id} <span className="pill">{tariff.currency}</span>
            </h2>
            <p className="muted">
              Used by {usedBy.join(", ") || "no connector"}
            </p>
            <ul>
              {lines.map((l) => (
                <li key={l.label}>
                  {l.label}: {l.value}
                </li>
              ))}
              <li>
                Card hold:{" "}
                {formatMoney(
                  tariff.authorization_minor || s.defaultHoldCents,
                  tariff.currency,
                )}
              </li>
            </ul>
            {form ? (
              <form action="/api/operator/prices" method="post">
                <input type="hidden" name="tariffId" value={tariff.id} />
                <div className="form-grid">
                  <label>
                    Energy per kWh ({unit})
                    <input
                      name="energyCentsPerKwh"
                      type="number"
                      min={0}
                      step={1}
                      defaultValue={form.energyCentsPerKwh}
                      required
                    />
                  </label>
                  <label>
                    Charging time per minute ({unit})
                    <input
                      name="timeCentsPerMinute"
                      type="number"
                      min={0}
                      step={1}
                      defaultValue={form.timeCentsPerMinute}
                      required
                    />
                  </label>
                  <label>
                    Idle fee per minute ({unit})
                    <input
                      name="idleCentsPerMinute"
                      type="number"
                      min={0}
                      step={1}
                      defaultValue={form.idleCentsPerMinute}
                      required
                    />
                  </label>
                  <label>
                    Session fee ({unit})
                    <input
                      name="sessionFeeCents"
                      type="number"
                      min={0}
                      step={1}
                      defaultValue={form.sessionFeeCents}
                      required
                    />
                  </label>
                  <label>
                    Card hold ({unit})
                    <input
                      name="holdCents"
                      type="number"
                      min={50}
                      max={50000}
                      step={1}
                      defaultValue={form.holdCents || s.defaultHoldCents}
                      required
                    />
                  </label>
                </div>
                {usedBy.length > 1 ? (
                  <p className="muted">
                    This tariff is shared: saving changes the price on every
                    connector listed above.
                  </p>
                ) : null}
                <button type="submit">Save prices</button>
              </form>
            ) : (
              <p className="muted">
                This tariff has time-of-day or other conditional prices. Edit it
                through the Ivora API.
              </p>
            )}
          </section>
        );
      })}
      <section className="card">
        <h2>Connectors and QR codes</h2>
        {data.qrProblem ? <p className="notice">{data.qrProblem}</p> : null}
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Table, scrolls sideways"
        >
          <table>
            <thead>
              <tr>
                <th>Charger</th>
                <th>Status</th>
                <th>Tariff</th>
                <th>Driver page</th>
              </tr>
            </thead>
            <tbody>
              {data.connectors.map((c) => (
                <tr key={`${c.stationName}-${c.connector}`}>
                  <td>
                    {c.stationName} #{c.connector}
                  </td>
                  <td>{c.status}</td>
                  <td>{c.tariffId ?? "none"}</td>
                  <td>
                    {c.driverUrl ? (
                      <>
                        {c.qrSvg ? (
                          <div
                            className="qr"
                            dangerouslySetInnerHTML={{ __html: c.qrSvg }}
                          />
                        ) : null}
                        <a href={c.driverUrl}>{c.driverUrl}</a>
                        {data.demo ? (
                          <div className="pill warn">Demo QR</div>
                        ) : null}
                      </>
                    ) : (
                      <span className="muted">
                        Set the station&apos;s external_reference to your own
                        code to print a QR.
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
