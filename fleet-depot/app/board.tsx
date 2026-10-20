"use client";
import { useCallback, useEffect, useState } from "react";

interface Profile {
  status: string;
  detail?: string;
  composite?: string;
}
interface PublicSession {
  id: string;
  station: string;
  connector: number;
  allocatedKw: number;
  deliveredKwh: number;
  idTokenHint?: string;
  profile?: Profile;
}
interface Vehicle {
  id: string;
  name: string;
  plate: string;
  batteryKwh: number;
  maxKw: number;
  driverId?: string;
  departure?: string;
  need?:
    { kind: "kwh"; kwh: number } | { kind: "battery"; targetPercent: number };
}
interface Row {
  vehicle: Vehicle;
  driver?: string;
  session?: PublicSession;
  soc?: number;
  socReported: boolean;
  remainingKwh?: number;
  readyBy?: boolean;
}
interface State {
  demo: boolean;
  now: string;
  settings: { siteCapKw: number; currency: string; centsPerKwh: number };
  totalKw: number;
  rows: Row[];
  unmatched: PublicSession[];
  drivers: {
    id: string;
    name: string;
    card?: string;
    cardBlocked: boolean;
    cardError?: string;
  }[];
  events: { id: string; at: string; type: string; detail: string }[];
}
interface Report {
  currency: string;
  rows: {
    key: string;
    label: string;
    sessions: number;
    kwh: number;
    costCents: number;
  }[];
}

const ERRORS_URL = "https://ivoracharge.com/developers/guides/reference/errors";

/** datetime-local value in the browser's time zone. */
function toLocalInput(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function Board({ signedIn }: { signedIn: boolean }) {
  const [s, setS] = useState<State | null>(null);
  const [csv, setCsv] = useState(
    "idTag,driverName,email\nFLEET001,Alex Rivera,alex@example.com",
  );
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [by, setBy] = useState<"vehicle" | "driver">("vehicle");
  const [report, setReport] = useState<Report | null>(null);
  const [edit, setEdit] = useState<{
    id: string;
    departure: string;
    needKind: "kwh" | "battery";
    needValue: string;
    driverId: string;
  } | null>(null);
  const [newDriver, setNewDriver] = useState({ name: "", idTag: "" });

  const load = useCallback(async () => {
    const r = await fetch("/api/state");
    if (r.status === 401) return location.reload();
    setS(await r.json());
    setReport(await (await fetch(`/api/reports?by=${by}`)).json());
  }, [by]);
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  async function post(url: string, body: unknown, ok = "") {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error)
      setMsg({ text: j.error ?? `HTTP ${r.status}`, error: true });
    else if (j.imported !== undefined)
      setMsg({
        text: `Imported ${j.imported}, ${j.errors.length} rejected${j.errors.length ? `: ${j.errors.map((e: { line?: number; row?: number; code?: string; message: string }) => `${e.line ? `line ${e.line}` : `row ${e.row}`} ${e.code ?? ""} ${e.message}`).join("; ")}` : ""}`,
        error: j.errors.length > 0,
      });
    else setMsg(ok ? { text: ok, error: false } : null);
    await load();
    return r.ok;
  }

  if (!s) return <main>Loading…</main>;
  const vehiclesFree = s.rows.filter((r) => !r.session).map((r) => r.vehicle);
  return (
    <main>
      <header className="top">
        <h1>Fleet depot</h1>
        {signedIn && (
          <button
            onClick={async () => {
              await fetch("/api/login", { method: "DELETE" });
              location.reload();
            }}
          >
            Sign out
          </button>
        )}
      </header>
      {s.demo && (
        <div className="banner" role="status">
          <b>Demo</b>: simulated depot with sample vehicles and drivers. No
          charger commands or API requests are sent. Simulated clock:{" "}
          {new Date(s.now).toLocaleString()}
        </div>
      )}
      <p>
        Site cap {s.settings.siteCapKw} kW, allocated{" "}
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
      {msg && (
        <p
          className={msg.error ? "warn" : "ok"}
          role={msg.error ? "alert" : "status"}
        >
          {msg.text}
          {msg.error && msg.text.includes("Ivora API error") && (
            <>
              {" "}
              <a href={ERRORS_URL} target="_blank" rel="noreferrer">
                Errors and statuses
              </a>
            </>
          )}
        </p>
      )}
      <h2>Live board</h2>
      <table>
        <thead>
          <tr>
            <th>Vehicle</th>
            <th>Driver</th>
            <th>Connector</th>
            <th>State of charge</th>
            <th>kW</th>
            <th>Departs</th>
            <th>Ready by</th>
            <th>Profile</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {s.rows.map((r) => (
            <tr key={r.vehicle.id}>
              <td>
                {r.vehicle.name} <small>{r.vehicle.plate}</small>
              </td>
              <td>{r.driver ?? "-"}</td>
              <td>
                {r.session
                  ? `${r.session.station} / ${r.session.connector}`
                  : "not plugged in"}
              </td>
              <td>
                {r.soc === undefined ? (
                  "not reported"
                ) : (
                  <span
                    title={
                      r.socReported
                        ? "reported by the charger"
                        : "estimated from energy delivered"
                    }
                  >
                    <span className="bar" aria-hidden="true">
                      <span style={{ width: `${r.soc}%` }} />
                    </span>{" "}
                    {r.soc.toFixed(0)}%{r.socReported ? "" : " (est.)"}
                  </span>
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
                  <span className="warn">
                    at risk ({r.remainingKwh?.toFixed(1)} kWh left)
                  </span>
                )}
              </td>
              <td>
                {r.session?.profile ? (
                  <span title={r.session.profile.detail}>
                    {r.session.profile.status}
                    {r.session.profile.composite
                      ? ` (${r.session.profile.composite})`
                      : ""}
                  </span>
                ) : (
                  "-"
                )}
              </td>
              <td>
                <button
                  onClick={() =>
                    setEdit({
                      id: r.vehicle.id,
                      departure: toLocalInput(r.vehicle.departure),
                      needKind: r.vehicle.need?.kind ?? "battery",
                      needValue: String(
                        r.vehicle.need?.kind === "kwh"
                          ? r.vehicle.need.kwh
                          : (r.vehicle.need?.targetPercent ?? 80),
                      ),
                      driverId: r.vehicle.driverId ?? "",
                    })
                  }
                >
                  Edit
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && (
        <form
          className="panel"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await post(
              "/api/vehicles",
              {
                id: edit.id,
                departure: edit.departure
                  ? new Date(edit.departure).toISOString()
                  : "",
                needKind: edit.needKind,
                needValue: Number(edit.needValue),
                driverId: edit.driverId,
              },
              "Saved; charging plan recomputed.",
            );
            if (ok) setEdit(null);
          }}
        >
          <h3>
            Departure for{" "}
            {s.rows.find((r) => r.vehicle.id === edit.id)?.vehicle.name}
          </h3>
          <label>
            Departure{" "}
            <input
              type="datetime-local"
              value={edit.departure}
              onChange={(e) => setEdit({ ...edit, departure: e.target.value })}
            />
          </label>
          <label>
            Energy needed as{" "}
            <select
              value={edit.needKind}
              onChange={(e) =>
                setEdit({
                  ...edit,
                  needKind: e.target.value as "kwh" | "battery",
                })
              }
            >
              <option value="battery">target battery %</option>
              <option value="kwh">kWh</option>
            </select>
          </label>
          <label>
            {edit.needKind === "kwh" ? "kWh" : "Target %"}{" "}
            <input
              type="number"
              min={0}
              max={edit.needKind === "kwh" ? 1000 : 100}
              step="any"
              value={edit.needValue}
              onChange={(e) => setEdit({ ...edit, needValue: e.target.value })}
            />
          </label>
          <label>
            Driver{" "}
            <select
              value={edit.driverId}
              onChange={(e) => setEdit({ ...edit, driverId: e.target.value })}
            >
              <option value="">none</option>
              {s.drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Save</button>
          <button type="button" onClick={() => setEdit(null)}>
            Cancel
          </button>
        </form>
      )}
      {s.unmatched.length > 0 && (
        <>
          <h2>Sessions without a vehicle</h2>
          <p>
            The card could not be matched to exactly one vehicle. These sessions
            get power last until you assign them.
          </p>
          <table>
            <tbody>
              {s.unmatched.map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.station} / {u.connector}
                  </td>
                  <td>card {u.idTokenHint ?? "unknown"}</td>
                  <td>{u.allocatedKw.toFixed(1)} kW</td>
                  <td>
                    <label>
                      Assign to{" "}
                      <select
                        defaultValue=""
                        onChange={(e) =>
                          e.target.value &&
                          post("/api/sessions", {
                            sessionId: u.id,
                            vehicleId: e.target.value,
                          })
                        }
                      >
                        <option value="">choose a vehicle</option>
                        {vehiclesFree.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
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
          {s.drivers.map((d) => (
            <tr key={d.id}>
              <td>{d.name}</td>
              <td>
                {d.card ?? "-"}{" "}
                {d.cardBlocked && <span className="warn">blocked</span>}
                {d.cardError && <span className="warn"> ({d.cardError})</span>}
              </td>
              <td>
                {d.card && !d.cardBlocked && (
                  <button
                    onClick={() =>
                      confirm(
                        `Block ${d.name}'s card? The charger will refuse it.`,
                      ) &&
                      post(
                        "/api/drivers",
                        { action: "block", id: d.id },
                        "Card blocked.",
                      )
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
      <form
        className="panel"
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            await post(
              "/api/drivers",
              { action: "create", ...newDriver },
              "Driver added.",
            )
          )
            setNewDriver({ name: "", idTag: "" });
        }}
      >
        <label>
          Driver name{" "}
          <input
            value={newDriver.name}
            onChange={(e) =>
              setNewDriver({ ...newDriver, name: e.target.value })
            }
            required
          />
        </label>
        <label>
          Card value (idTag){" "}
          <input
            value={newDriver.idTag}
            onChange={(e) =>
              setNewDriver({ ...newDriver, idTag: e.target.value })
            }
          />
        </label>
        <button type="submit">Add driver</button>
      </form>
      <div className="panel">
        <label htmlFor="cards-csv">
          Import cards as CSV: idTag, driverName, email (optional)
        </label>
        <textarea
          id="cards-csv"
          rows={4}
          cols={60}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
        />
        <button onClick={() => post("/api/drivers", { action: "import", csv })}>
          Import cards (CSV)
        </button>
      </div>
      <h2>Monthly report</h2>
      <label htmlFor="report-by">Group by</label>{" "}
      <select
        id="report-by"
        value={by}
        onChange={(e) => setBy(e.target.value as "vehicle" | "driver")}
      >
        <option value="vehicle">Per vehicle</option>
        <option value="driver">Per driver</option>
      </select>{" "}
      <a href={`/api/reports?by=${by}&format=csv`}>Download CSV</a>
      <p>
        <small>
          Tariff {(s.settings.centsPerKwh / 100).toFixed(2)}{" "}
          {s.settings.currency}/kWh; months are UTC.
        </small>
      </p>
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
            {report.rows.map((r) => (
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
          {s.events.map((e) => (
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
