"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Report, State } from "./types";
import Timeline from "./timeline";
import { StatusChip } from "./timeline";
import PowerChart from "./power-chart";
import SimControls from "./sim-controls";
import ApiPanel from "./api-panel";
import Wall from "./wall";
import { clock, statusOf } from "@/lib/timeline";
import { collapseEvents } from "@/lib/calls";

const ERRORS_URL = "https://ivoracharge.com/developers/guides/reference/errors";

/** datetime-local value in the browser's time zone, or in UTC (demo depot time). */
function toLocalInput(iso?: string, tz?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (tz === "UTC") return d.toISOString().slice(0, 16);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The instant a datetime-local value means, read in the same zone. */
const fromLocalInput = (v: string, tz?: string) =>
  new Date(tz === "UTC" ? `${v}Z` : v).toISOString();

type Tab = "overview" | "vehicles" | "sessions" | "settings";
const TABS: [Tab, string][] = [
  ["overview", "Overview"],
  ["vehicles", "Vehicles and cards"],
  ["sessions", "Sessions and cost"],
  ["settings", "Settings"],
];

/** What a failed load tells the operator: a code and the next step (docs/conventions.md). */
interface LoadError {
  code: string;
  text: string;
}

function Skeleton() {
  return (
    <main id="main" aria-busy="true" aria-label="Loading the depot">
      <div className="skel" style={{ height: 36, width: 220 }} />
      <div className="skel" style={{ height: 150, marginTop: 16 }} />
      <div className="skel" style={{ height: 320, marginTop: 16 }} />
      <p className="sr">Loading the depot…</p>
    </main>
  );
}

export default function Board({ signedIn }: { signedIn: boolean }) {
  const [s, setS] = useState<State | null>(null);
  const [csv, setCsv] = useState(
    "idTag,driverName,email\nFLEET001,Alex Rivera,alex@example.com",
  );
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [by, setBy] = useState<"vehicle" | "driver">("vehicle");
  const [report, setReport] = useState<Report | null>(null);
  const [month, setMonth] = useState<"this" | "last">("this");
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [tv, setTv] = useState(false);
  const [edit, setEdit] = useState<{
    id: string;
    departure: string;
    needKind: "kwh" | "battery";
    needValue: string;
    driverId: string;
  } | null>(null);
  const [newDriver, setNewDriver] = useState({ name: "", idTag: "" });

  const speed = s?.sim?.speed ?? 0;
  const nowIso = s?.now;
  const monthKey = useMemo(() => {
    const d = new Date(nowIso ?? Date.now());
    if (month === "last") d.setUTCMonth(d.getUTCMonth() - 1, 1);
    return d.toISOString().slice(0, 7);
  }, [nowIso, month]);

  const loadState = useCallback(async () => {
    try {
      const r = await fetch("/api/state");
      if (r.status === 401) return location.reload();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setS(await r.json());
      setLoadError(null);
    } catch (e) {
      setLoadError({
        code: e instanceof Error ? e.message : "network",
        text: "Could not load the depot.",
      });
    }
  }, []);
  const loadReport = useCallback(async () => {
    try {
      const rep = await fetch(`/api/reports?by=${by}&month=${monthKey}`);
      if (!rep.ok) throw new Error(`HTTP ${rep.status} (report)`);
      setReport(await rep.json());
    } catch (e) {
      setLoadError({
        code: e instanceof Error ? e.message : "network",
        text: "Could not load the report.",
      });
    }
  }, [by, monthKey]);
  const load = useCallback(async () => {
    await loadState();
    await loadReport();
  }, [loadState, loadReport]);
  // The demo clock runs on the server and catches up on each read: poll every
  // second while it runs, every ten seconds otherwise.
  useEffect(() => {
    loadState();
    const t = setInterval(loadState, speed > 0 ? 1000 : 10000);
    return () => clearInterval(t);
  }, [loadState, speed]);
  useEffect(() => {
    loadReport();
    const t = setInterval(loadReport, 10000);
    return () => clearInterval(t);
  }, [loadReport]);
  const exitTv = useCallback(() => {
    setTv(false);
    if (location.search) history.replaceState(null, "", location.pathname);
  }, []);
  // A direct link for the TV: /depot?wall=1.
  useEffect(() => {
    if (new URLSearchParams(location.search).get("wall") === "1") setTv(true);
  }, []);
  useEffect(() => {
    if (!tv) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && exitTv();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [tv, exitTv]);

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

  if (!s)
    return loadError ? (
      <main id="main">
        <LoadFailed e={loadError} retry={load} />
      </main>
    ) : (
      <Skeleton />
    );
  const vehiclesFree = s.rows.filter((r) => !r.session).map((r) => r.vehicle);
  const cap = s.settings.siteCapKw;
  const used = cap > 0 ? Math.min(100, (s.totalKw / cap) * 100) : 0;
  const count = { charging: 0, waiting: 0, ready: 0, late: 0, away: 0 };
  for (const r of s.rows) count[statusOf(r)]++;
  const freeKw = Math.max(0, cap - s.totalKw);
  const nowLabel = clock(s.sim?.at ?? Date.parse(s.now), s.tz);

  const gauge = (
    <section className="panel gauge" aria-labelledby="power">
      <h2 id="power">
        Site power <span className="num">{cap} kW cap</span>
      </h2>
      <p className="hero num">
        {s.totalKw.toFixed(1)} <small>kW allocated</small>
      </p>
      <div
        className="meter"
        role="img"
        aria-label={`${s.totalKw.toFixed(1)} kW allocated of the ${cap} kW site cap, ${used.toFixed(0)}%, ${freeKw.toFixed(1)} kW free`}
      >
        <i style={{ width: `${used}%` }} />
        <b className="cap" />
      </div>
      <div className="scale num" aria-hidden="true">
        <span>0</span>
        <span>{cap} kW cap</span>
      </div>
      <p className="sum">
        {count.charging + count.late} charging, {count.waiting} waiting
        {count.away ? `, ${count.away} not arrived` : ""}.{" "}
        <span className="num">{freeKw.toFixed(1)} kW</span> free.
      </p>
      <dl className="kpis">
        {(
          [
            ["charging", count.charging],
            ["waiting", count.waiting],
            ["ready", count.ready],
            ["late", count.late],
          ] as const
        ).map(([k, n]) => (
          <div className="kpi" key={k}>
            <dt>
              <StatusChip status={k} />
            </dt>
            <dd className="num">{n}</dd>
          </div>
        ))}
      </dl>
    </section>
  );

  if (tv)
    return (
      <Wall
        s={s}
        onExit={exitTv}
        error={loadError ? `${loadError.text} ${loadError.code}` : undefined}
      />
    );

  return (
    <main id="main">
      <header className="top">
        <h1>Depot overview</h1>
        {s.tz && <span className="tzlab">Depot time</span>}
        <span className="num clock">{nowLabel}</span>
      </header>
      {s.demo && (
        <div className="banner" role="status">
          <b>Demo</b>: simulated depot with sample vehicles and drivers. No
          charger commands or API requests are sent.
        </div>
      )}
      <div className="tabs" role="tablist" aria-label="Sections">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls="tabpanel"
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={(e) => {
              const d =
                e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              if (!d) return;
              const next =
                TABS[
                  (TABS.findIndex(([t]) => t === tab) + d + TABS.length) %
                    TABS.length
                ][0];
              setTab(next);
              requestAnimationFrame(() =>
                document.getElementById(`tab-${next}`)?.focus(),
              );
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {loadError && <LoadFailed e={loadError} retry={load} />}
      {msg && (
        <p
          className={msg.error ? "msg warn" : "msg ok"}
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
      <div id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "overview" && (
          <div className="grid2">
            <div className="side">
              {gauge}
              {s.demo && <SimControls s={s} post={post} />}
            </div>
            <div className="main-col">
              {s.demo && <PowerChart s={s} />}
              <section className="panel flush" aria-labelledby="tl-h">
                <h2 id="tl-h">Departures</h2>
                <Timeline s={s} />
              </section>
              <section aria-labelledby="ev-h">
                <h2 id="ev-h">Events</h2>
                {s.events.length === 0 ? (
                  <p className="empty">
                    No events yet. Plug-ins, plan changes and card actions are
                    listed here.
                  </p>
                ) : (
                  <div
                    className="logbox"
                    tabIndex={0}
                    role="region"
                    aria-label="Event log"
                  >
                    <ul className="log">
                      {collapseEvents(s.events).map((e) => (
                        <li key={e.id}>
                          <span className="num">
                            {clock(Date.parse(e.at), s.tz)}
                          </span>
                          <b>{e.type}</b>
                          <span>{e.detail}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
              {s.demo && <ApiPanel s={s} />}
            </div>
          </div>
        )}
        {tab === "vehicles" && (
          <>
            <h2>Vehicles</h2>
            {s.rows.length === 0 && (
              <p className="empty">No vehicles in the depot yet.</p>
            )}
            <ul className="cards">
              {s.rows.map((r) => (
                <li className="panel vcard" key={r.vehicle.id}>
                  <div>
                    <b>{r.vehicle.name}</b>{" "}
                    <small className="num">{r.vehicle.plate}</small>
                    <div className="sub">
                      {r.driver ?? "no driver"} ·{" "}
                      <span className="num">
                        {r.vehicle.batteryKwh} kWh, {r.vehicle.maxKw} kW max
                      </span>
                    </div>
                  </div>
                  <div className="sub">
                    Departs{" "}
                    <span className="num">
                      {r.vehicle.departure
                        ? new Date(r.vehicle.departure).toLocaleString(
                            s.tz ? "en-GB" : [],
                            {
                              weekday: "short",
                              hour: "2-digit",
                              minute: "2-digit",
                              timeZone: s.tz,
                            },
                          )
                        : "-"}
                    </span>
                    {" · "}
                    {r.soc === undefined ? (
                      "charge not reported"
                    ) : (
                      <span
                        className="num"
                        title={
                          r.socReported
                            ? "reported by the charger"
                            : "estimated from energy delivered"
                        }
                      >
                        {r.soc.toFixed(0)}%{r.socReported ? "" : " (est.)"}
                      </span>
                    )}
                    {r.session?.profile && (
                      <>
                        {" · "}
                        <span title={r.session.profile.detail}>
                          profile {r.session.profile.status}
                          {r.session.profile.composite
                            ? ` (${r.session.profile.composite})`
                            : ""}
                        </span>
                      </>
                    )}
                  </div>
                  <StatusChip status={statusOf(r)} />
                  <button
                    onClick={() =>
                      setEdit({
                        id: r.vehicle.id,
                        departure: toLocalInput(r.vehicle.departure, s.tz),
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
                </li>
              ))}
            </ul>
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
                        ? fromLocalInput(edit.departure, s.tz)
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
                  Departure{s.tz ? " (depot time)" : ""}{" "}
                  <input
                    type="datetime-local"
                    value={edit.departure}
                    onChange={(e) =>
                      setEdit({ ...edit, departure: e.target.value })
                    }
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
                    onChange={(e) =>
                      setEdit({ ...edit, needValue: e.target.value })
                    }
                  />
                </label>
                <label>
                  Driver{" "}
                  <select
                    value={edit.driverId}
                    onChange={(e) =>
                      setEdit({ ...edit, driverId: e.target.value })
                    }
                  >
                    <option value="">none</option>
                    {s.drivers.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="primary">
                  Save
                </button>
                <button type="button" onClick={() => setEdit(null)}>
                  Cancel
                </button>
              </form>
            )}
            <h2>Sessions without a vehicle</h2>
            {s.unmatched.length === 0 ? (
              <p className="empty">Every session is matched to a vehicle.</p>
            ) : (
              <>
                <p>
                  The card could not be matched to exactly one vehicle. These
                  sessions get power last until you assign them.
                </p>
                <ul className="cards">
                  {s.unmatched.map((u) => (
                    <li className="panel vcard" key={u.id}>
                      <span className="num">
                        {u.station} / {u.connector}
                      </span>
                      <span className="num">
                        card {u.idTokenHint ?? "unknown"}
                      </span>
                      <span className="num">{u.allocatedKw.toFixed(1)} kW</span>
                      <label>
                        Assign to
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
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h2>Drivers and RFID cards</h2>
            {s.drivers.length === 0 && (
              <p className="empty">No drivers yet. Add one below.</p>
            )}
            <ul className="cards">
              {s.drivers.map((d) => (
                <li className="panel vcard" key={d.id}>
                  <b>{d.name}</b>
                  <span>
                    <span className="num">{d.card ?? "-"}</span>{" "}
                    {d.cardBlocked && (
                      <span className="chip late">
                        <i className="ic" aria-hidden="true" />
                        blocked
                      </span>
                    )}
                    {d.cardError && (
                      <span className="warn"> ({d.cardError})</span>
                    )}
                  </span>
                  {d.card && !d.cardBlocked ? (
                    <button
                      className="danger"
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
                  ) : (
                    <span />
                  )}
                </li>
              ))}
            </ul>
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
              <button type="submit" className="primary">
                Add driver
              </button>
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
              <button
                onClick={() => post("/api/drivers", { action: "import", csv })}
              >
                Import cards (CSV)
              </button>
            </div>
          </>
        )}
        {tab === "sessions" && (
          <>
            <h2>Cost</h2>
            <div className="toolbar">
              <label htmlFor="report-by">Group by</label>
              <select
                id="report-by"
                value={by}
                onChange={(e) => setBy(e.target.value as "vehicle" | "driver")}
              >
                <option value="vehicle">Per vehicle</option>
                <option value="driver">Per driver</option>
              </select>
              <label htmlFor="report-month">Month</label>
              <select
                id="report-month"
                value={month}
                onChange={(e) => setMonth(e.target.value as "this" | "last")}
              >
                <option value="this">This month</option>
                <option value="last">Last month</option>
              </select>
              <a href={`/api/reports?by=${by}&month=${monthKey}&format=csv`}>
                Download CSV
              </a>
            </div>
            <p className="note">
              <small className="num">
                Tariff {(s.settings.centsPerKwh / 100).toFixed(2)}{" "}
                {s.settings.currency}/kWh; months are UTC.
              </small>
            </p>
            {!report ? (
              <div className="skel" style={{ height: 160 }} />
            ) : report.rows.length === 0 ? (
              <p className="empty">
                No sessions in this month. Cost appears here once a charge
                finishes.
              </p>
            ) : (
              <CostRows report={report} />
            )}
          </>
        )}
        {tab === "settings" && (
          <>
            <h2>Site</h2>
            <dl className="panel facts">
              <div>
                <dt>Site power cap</dt>
                <dd className="num">{cap} kW</dd>
              </div>
              <div>
                <dt>Tariff</dt>
                <dd className="num">
                  {(s.settings.centsPerKwh / 100).toFixed(2)}{" "}
                  {s.settings.currency}/kWh
                </dd>
              </div>
              <div>
                <dt>Mode</dt>
                <dd>{s.demo ? "Demo (simulated)" : "Live"}</dd>
              </div>
            </dl>
            <p className="note">
              The cap and tariff are set in the environment (see the README), so
              they cannot be changed here.
            </p>
            <h2>Display</h2>
            <div className="actions">
              <button onClick={() => setTv(true)}>
                Wall display (TV mode)
              </button>
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
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function LoadFailed({ e, retry }: { e: LoadError; retry: () => void }) {
  return (
    <div className="msg warn" role="alert">
      {e.text} <span className="num">Error {e.code}.</span> Check that the depot
      app is running and your network is up, then retry. The last figures stay
      on screen. <button onClick={retry}>Retry</button>
    </div>
  );
}

function CostRows({ report }: { report: Report }) {
  const max = Math.max(1, ...report.rows.map((r) => r.costCents));
  return (
    <ul className="cost">
      {report.rows.map((r) => (
        <li key={r.key}>
          <span className="lab">{r.label}</span>
          <span className="num amt">
            {(r.costCents / 100).toFixed(2)} {report.currency}
          </span>
          <span
            className="costbar"
            role="img"
            aria-label={`${r.label}: ${(r.costCents / 100).toFixed(2)} ${report.currency}, ${r.kwh.toFixed(1)} kWh, ${r.sessions} sessions`}
          >
            <i style={{ width: `${(r.costCents / max) * 100}%` }} />
          </span>
          <small className="num">
            {r.kwh.toFixed(1)} kWh · {r.sessions} sessions
          </small>
        </li>
      ))}
    </ul>
  );
}
