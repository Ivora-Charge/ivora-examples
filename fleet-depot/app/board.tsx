"use client";
import { useCallback, useEffect, useState } from "react";

/* eslint-disable @typescript-eslint/no-explicit-any */
type State = any;

export default function Board() {
  const [s, setS] = useState<State>(null);
  const [csv, setCsv] = useState(
    "idTag,driverName,email\nFLEET001,Alex Rivera,alex@example.com",
  );
  const [msg, setMsg] = useState("");
  const [by, setBy] = useState<"vehicle" | "driver">("vehicle");
  const [report, setReport] = useState<any>(null);

  const load = useCallback(async () => {
    setS(await (await fetch("/api/state")).json());
    setReport(await (await fetch(`/api/reports?by=${by}`)).json());
  }, [by]);
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  async function post(url: string, body: unknown) {
    const r = await fetch(url, { method: "POST", body: JSON.stringify(body) });
    const j = await r.json();
    setMsg(
      j.error ??
        (j.imported !== undefined
          ? `Imported ${j.imported}, ${j.errors.length} rejected`
          : ""),
    );
    await load();
  }

  if (!s) return <main>Loading…</main>;
  return (
    <main>
      <h1>Fleet depot</h1>
      {s.demo && (
        <div className="banner">
          Demo data: simulated vehicles, no charger commands are sent. Clock:{" "}
          {new Date(s.now).toLocaleString()}
        </div>
      )}
      <p>
        Site cap {s.settings.siteCapKw} kW, in use{" "}
        <b>{s.totalKw.toFixed(1)} kW</b>
        {s.demo && (
          <>
            {" "}
            <button
              onClick={() =>
                post("/api/state", { action: "advance", minutes: 60 })
              }
            >
              Advance 1 h
            </button>
            <button
              onClick={() =>
                post("/api/state", { action: "advance", minutes: 480 })
              }
            >
              Advance 8 h
            </button>
          </>
        )}
      </p>
      {msg && <p className="warn">{msg}</p>}
      <h2>Live board</h2>
      <table>
        <thead>
          <tr>
            <th>Vehicle</th>
            <th>Driver</th>
            <th>Connector</th>
            <th>Charge</th>
            <th>kW</th>
            <th>Departs</th>
            <th>Ready by</th>
            <th>Profile</th>
          </tr>
        </thead>
        <tbody>
          {s.rows.map((r: any) => (
            <tr key={r.vehicle.id}>
              <td>
                {r.vehicle.name} <small>{r.vehicle.plate}</small>
              </td>
              <td>{r.driver?.name}</td>
              <td>
                {r.session
                  ? `${r.session.stationId} / ${r.session.connectorId}`
                  : "not plugged in"}
              </td>
              <td>
                {r.soc === undefined ? (
                  "n/a"
                ) : (
                  <div className="bar" title={`${r.soc.toFixed(0)}%`}>
                    <div style={{ width: `${r.soc}%` }} />
                  </div>
                )}
              </td>
              <td>{r.session ? r.session.allocatedKw.toFixed(1) : "-"}</td>
              <td>
                {r.vehicle.departure
                  ? new Date(r.vehicle.departure).toLocaleString([], {
                      weekday: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "-"}
              </td>
              <td>
                {r.readyBy === undefined ? (
                  "-"
                ) : r.readyBy ? (
                  <span className="ok">on track</span>
                ) : (
                  <span className="warn">at risk</span>
                )}
              </td>
              <td>
                {r.session?.profile
                  ? `${r.session.profile.status}${r.session.profile.composite ? ` (${r.session.profile.composite})` : ""}`
                  : "-"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Drivers and RFID cards</h2>
      <table>
        <thead>
          <tr>
            <th>Driver</th>
            <th>Card</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {s.drivers.map((d: any) => (
            <tr key={d.id}>
              <td>{d.name}</td>
              <td>
                {d.idTag ?? "-"}{" "}
                {d.cardBlocked && <span className="warn">blocked</span>}
              </td>
              <td>
                {d.idTag && !d.cardBlocked && (
                  <button
                    onClick={() =>
                      post("/api/drivers", { action: "block", id: d.id })
                    }
                  >
                    Block (driver left)
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <textarea
        rows={4}
        cols={60}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
      />
      <button onClick={() => post("/api/drivers", { action: "import", csv })}>
        Import cards (CSV)
      </button>
      <h2>Monthly report</h2>
      <select
        value={by}
        onChange={(e) => setBy(e.target.value as "vehicle" | "driver")}
      >
        <option value="vehicle">Per vehicle</option>
        <option value="driver">Per driver</option>
      </select>{" "}
      <a href={`/api/reports?by=${by}&format=csv`}>Download CSV</a>
      {report && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Sessions</th>
              <th>Energy (kWh)</th>
              <th>Cost ({report.currency})</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r: any) => (
              <tr key={r.key}>
                <td>{r.label}</td>
                <td>{r.sessions}</td>
                <td>{r.kwh.toFixed(1)}</td>
                <td>{(r.costCents / 100).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Events</h2>
      <table>
        <tbody>
          {s.events.map((e: any) => (
            <tr key={e.id}>
              <td>{new Date(e.at).toLocaleTimeString()}</td>
              <td>{e.type}</td>
              <td>{e.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
