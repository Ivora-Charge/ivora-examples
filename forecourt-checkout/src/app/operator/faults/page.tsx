import { ErrorBox } from "@/components/error-box";
import { OperatorNav } from "@/components/operator-nav";
import { errorInfo } from "@/lib/server/http";
import { faultsPage } from "@/lib/server/operator";
import { requireOperator } from "@/lib/server/operator-page";
import { formatLocalDateTime } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function Faults() {
  const s = await requireOperator();
  let data: Awaited<ReturnType<typeof faultsPage>>;
  try {
    data = await faultsPage(s);
  } catch (error) {
    return (
      <main className="wide">
        <OperatorNav current="faults" />
        <ErrorBox info={errorInfo(error).body} title="Could not load faults" />
      </main>
    );
  }
  return (
    <main className="wide">
      <OperatorNav current="faults" />
      <h1>Recent faults</h1>
      {data.demo ? <p className="notice">Demo data.</p> : null}
      <section className="card">
        {data.rows.length === 0 ? (
          <p className="muted">No faults reported.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Opened</th>
                  <th>Charger</th>
                  <th>Error</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((f) => (
                  <tr key={f.id}>
                    <td>{formatLocalDateTime(f.openedAt, s.siteTimeZone)}</td>
                    <td>
                      {f.station}
                      {f.connectorId
                        ? ` · connector ${f.connectorId}`
                        : " · whole station"}
                    </td>
                    <td>
                      <code>{f.errorCode ?? "Faulted"}</code>
                      {f.info ? <div className="muted">{f.info}</div> : null}
                    </td>
                    <td>
                      {f.open ? (
                        <span className="pill bad">Open</span>
                      ) : (
                        <span className="pill ok">
                          Cleared{" "}
                          {formatLocalDateTime(f.clearedAt, s.siteTimeZone)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted">
          From the chargers&apos; OCPP status notifications. Cleared faults are
          kept for 90 days.
        </p>
      </section>
    </main>
  );
}
