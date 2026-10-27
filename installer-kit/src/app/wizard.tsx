"use client";
import { useEffect, useState } from "react";
import { brand as copy } from "../../brand/brand";
import { describe } from "@/lib/status";
import {
  currencyExponent,
  currencyOr,
  formatMinor,
  PRICE_CURRENCIES,
} from "@/lib/money";
import { quoteMinor } from "@/lib/tariff";
import {
  TEST_SESSION_LABEL,
  type Charger,
  type ConfigKey,
  type LocationOption,
  type Site,
} from "@/lib/types";
import { formatKwh } from "@/lib/units";

const GENERIC_NOTES = `- Open the charger's installer app or web UI and find the OCPP / backend settings.
- Set the protocol to OCPP 1.6J (JSON over WebSocket).
- Central system URL: the connection URL above. If the charger has a separate "charge point ID" field, enter the base URL there without the last path segment and the connection name as the ID.
- Security profile 1 (Basic authentication): user = connection name, password = the password above.
- Save, reboot the charger, and come back to this page.`;
const NOTES_KEY = "installer-kit:setup-notes";

type ApiError = {
  error: string;
  message: string;
  docs?: string;
  request_id?: string;
};
type Created = {
  charger: Charger;
  password: string | null;
  passwordError?: ApiError;
  qr: { url: string; password: string | null };
};

class RequestError extends Error {
  constructor(public detail: ApiError) {
    super(detail.message);
  }
}

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(
    url,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new RequestError({
      error: json.error ?? `http_${res.status}`,
      message: json.message ?? "Request failed.",
      docs: json.docs,
      request_id: json.request_id,
    });
  return json as T;
}

/** What the operator can do about an error, by kind (see docs/conventions.md). */
function nextStep(e: ApiError): string {
  if (e.error === "network_error")
    return "Check your connection, then try again.";
  if (/^(unauthorized|http_401|http_403)/.test(e.error))
    return "Sign in again, then retry.";
  if (/^(http_5|operator_password_missing|configuration)/.test(e.error))
    return "This is not something you can fix on site. Tell the site operator and try again later.";
  return "Check the value you entered, then try again.";
}

function ErrorNote({ e }: { e: ApiError }) {
  return (
    <p role="alert" className="error">
      <strong>{e.error}</strong>: {e.message}
      {e.request_id && <> (request {e.request_id})</>} {nextStep(e)}{" "}
      {e.docs && (
        <a href={e.docs} target="_blank" rel="noreferrer">
          Errors and statuses
        </a>
      )}
    </p>
  );
}

function Copy({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 2500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <>
      <button
        type="button"
        className="secondary"
        aria-label={`Copy ${label}`}
        onClick={() =>
          navigator.clipboard.writeText(value).then(() => setDone(true))
        }
      >
        {done ? "Copied" : "Copy"}
      </button>
      <span className="sr" role="status">
        {done ? `${label} copied` : ""}
      </span>
    </>
  );
}

const STEPS = ["Site", "Connect charger", "Test", "Price", "Hand over"];

/** Desktop step rail; on phones CSS turns it into "Step n of 5" and segments. */
function Steps({ now }: { now: number }) {
  return (
    <nav className="steps" aria-label="Progress">
      <p className="steps-count" aria-hidden="true">
        Step {now} of {STEPS.length}
      </p>
      <ol>
        {STEPS.map((name, i) => {
          const n = i + 1;
          const state = n < now ? "done" : n === now ? "now" : "next";
          return (
            <li key={name} className={state}>
              {state === "done" ? (
                <a href={`#step-${n}`}>
                  {name}
                  <span className="sr">, done</span>
                </a>
              ) : (
                <span aria-current={state === "now" ? "step" : undefined}>
                  {name}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function defaultName() {
  return `ik-${Math.random().toString(36).slice(2, 8)}`;
}

export default function Wizard({
  demo,
  qrProblem,
}: {
  demo: boolean;
  qrProblem: string | null;
}) {
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [sitesState, setSitesState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [picked, setPicked] = useState("");
  const [site, setSite] = useState<Site>();
  const [form, setForm] = useState({
    name: "",
    address: "",
    city: "",
    state: "",
    postalCode: "",
    country: "USA",
  });
  const [stationName, setStationName] = useState("");
  const [connectorCount, setConnectorCount] = useState(1);
  const [created, setCreated] = useState<Created>();
  const [charger, setCharger] = useState<Charger>();
  const [notes, setNotes] = useState<Record<string, string>>({
    "Generic OCPP 1.6J": GENERIC_NOTES,
  });
  const [brand, setBrand] = useState("Generic OCPP 1.6J");
  const [newBrand, setNewBrand] = useState("");
  const [testConnector, setTestConnector] = useState(1);
  const [configKey, setConfigKey] = useState<ConfigKey>("HeartbeatInterval");
  const [configValue, setConfigValue] = useState("300");
  const [configAnswer, setConfigAnswer] = useState<string>();
  const [tariff, setTariff] = useState(35);
  // Chosen by the installer; until then the site's currency, else the default.
  const [pickedCurrency, setPickedCurrency] = useState<string>();
  const currency = pickedCurrency ?? currencyOr(site?.currency);
  const [, setTick] = useState(0);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await f();
    } catch (e) {
      setError(
        e instanceof RequestError
          ? e.detail
          : { error: "network_error", message: String(e) },
      );
    } finally {
      setBusy(false);
    }
  };

  const loadSites = () => {
    setSitesState("loading");
    return run(async () => {
      try {
        const res = await api<{ sites: Site[]; locations: LocationOption[] }>(
          "/api/sites",
        );
        setLocations(res.locations);
        setSitesState("ready");
      } catch (e) {
        setSitesState("error");
        throw e;
      }
    });
  };

  useEffect(() => {
    setStationName(defaultName());
    const saved = localStorage.getItem(NOTES_KEY);
    if (saved) setNotes(JSON.parse(saved));
    loadSites();
  }, []);

  useEffect(() => {
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  }, [notes]);

  const testRunning =
    charger?.test &&
    ["starting", "charging", "stopping"].includes(charger.test.phase);

  // Poll while waiting for the charger or while a test is running.
  useEffect(() => {
    if (!charger || (charger.state === "booted" && !testRunning)) return;
    const t = setInterval(() => {
      setTick((n) => n + 1);
      api<Charger>(`/api/chargers/${charger.id}`)
        .then(setCharger)
        .catch((e) => e instanceof RequestError && setError(e.detail));
    }, 2000);
    return () => clearInterval(t);
  }, [charger?.id, charger?.state, testRunning]);

  const waited = charger
    ? (Date.now() - Date.parse(charger.lastChangeAt)) / 1000
    : 0;
  const status = describe(charger?.state ?? "waiting", waited);
  const field = (key: keyof typeof form, label: string, required = false) => (
    <label>
      {label}
      <input
        value={form[key]}
        required={required}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </label>
  );

  const step = !site
    ? 1
    : charger?.state !== "booted"
      ? 2
      : charger.test?.phase !== "done"
        ? 3
        : charger.tariffMinorPerKwh === undefined
          ? 4
          : 5;

  return (
    <div className="wizard">
      <Steps now={step} />
      {error && <ErrorNote e={error} />}

      <section id="step-1" aria-labelledby="h-1">
        <h2 id="h-1">1. Site</h2>
        {site ? (
          <p>
            <strong>{site.name}</strong>, {site.address}
          </p>
        ) : (
          <>
            {sitesState === "loading" && (
              <div aria-busy="true" aria-label="Loading locations">
                <div className="skeleton line" />
                <div className="skeleton line short" />
              </div>
            )}
            {sitesState === "error" && (
              <p>
                <button type="button" className="secondary" onClick={loadSites}>
                  Retry loading locations
                </button>
              </p>
            )}
            {sitesState === "ready" && locations.length === 0 && (
              <p className="empty">
                No locations in this account yet. Create your first site below.
              </p>
            )}
            {locations.length > 0 && (
              <div className="row">
                <label>
                  Existing location
                  <select
                    value={picked}
                    onChange={(e) => setPicked(e.target.value)}
                  >
                    <option value="">Choose…</option>
                    {locations.map((l) => (
                      <option key={l.locationId} value={l.locationId}>
                        {l.name} ({l.address})
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={!picked || busy}
                  onClick={() =>
                    run(async () =>
                      setSite(
                        await api<Site>("/api/sites", { locationId: picked }),
                      ),
                    )
                  }
                >
                  Use this location
                </button>
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => setSite(await api<Site>("/api/sites", form)));
              }}
            >
              <h3>Or create a new site</h3>
              <div className="grid">
                {field("name", "Site name", true)}
                {field("address", "Street address", true)}
                {field("city", "City")}
                {field("state", "State or region")}
                {field("postalCode", "Postal code")}
                {field("country", "Country (3 letters)")}
              </div>
              <button type="submit" disabled={busy}>
                Create site
              </button>
            </form>
          </>
        )}
      </section>

      {site && (
        <section id="step-2" aria-labelledby="h-2">
          <h2 id="h-2">2. Connect charger</h2>
          {!created ? (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  const c = await api<Created>("/api/chargers", {
                    siteId: site.id,
                    name: stationName,
                    connectors: connectorCount,
                  });
                  setCreated(c);
                  setCharger(c.charger);
                });
              }}
            >
              <label>
                Connection name (charge point ID)
                <input
                  value={stationName}
                  pattern="[a-zA-Z0-9][a-zA-Z0-9_\-]{2,35}"
                  required
                  onChange={(e) => setStationName(e.target.value)}
                />
              </label>
              <label>
                Connectors
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={connectorCount}
                  onChange={(e) => setConnectorCount(Number(e.target.value))}
                />
              </label>
              <button type="submit" disabled={busy}>
                Add charger
              </button>
            </form>
          ) : (
            <Credentials
              created={created}
              busy={busy}
              onHide={() =>
                setCreated({
                  ...created,
                  password: null,
                  qr: { ...created.qr, password: null },
                })
              }
              onRotate={() =>
                run(async () => {
                  const c = await api<Created>(
                    `/api/chargers/${created.charger.id}/credentials`,
                    {},
                  );
                  setCreated(c);
                  setCharger(c.charger);
                })
              }
            />
          )}
          {created && (
            <>
              <h3>Setup notes</h3>
              <div className="row">
                <label>
                  Charger brand
                  <select
                    value={brand}
                    onChange={(e) => setBrand(e.target.value)}
                  >
                    {Object.keys(notes).map((b) => (
                      <option key={b}>{b}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Add a brand
                  <input
                    value={newBrand}
                    onChange={(e) => setNewBrand(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="secondary"
                  disabled={!newBrand.trim()}
                  onClick={() => {
                    const b = newBrand.trim();
                    setNotes({ ...notes, [b]: notes[b] ?? GENERIC_NOTES });
                    setBrand(b);
                    setNewBrand("");
                  }}
                >
                  Add
                </button>
              </div>
              <label className="block">
                Steps for {brand} (Markdown list, saved in this browser)
                <textarea
                  rows={7}
                  value={notes[brand] ?? ""}
                  onChange={(e) =>
                    setNotes({ ...notes, [brand]: e.target.value })
                  }
                />
              </label>
            </>
          )}
        </section>
      )}

      {charger && (
        <section aria-labelledby="h-online">
          <h2 id="h-online">Online check</h2>
          {charger.state === "booted" ? (
            <p className="status live" role="status">
              Charger online. {status.label}.
            </p>
          ) : (
            <>
              <p className="status waiting" role="status">
                {status.label}
              </p>
              <p className="hint">{copy.connectHint}</p>
            </>
          )}
          {status.hints.length > 0 && <p className="muted">{copy.support}</p>}
          {status.hints.length > 0 && (
            <ul>
              {status.hints.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          )}
          {charger.boot && (
            <dl>
              <dt>Vendor</dt>
              <dd>{charger.boot.vendor ?? "-"}</dd>
              <dt>Model</dt>
              <dd>{charger.boot.model ?? "-"}</dd>
              <dt>Firmware</dt>
              <dd>{charger.boot.firmware ?? "reported at boot"}</dd>
              <dt>Connectors</dt>
              <dd>
                {charger.connectors.map((k) => `#${k.number}`).join(", ") ||
                  "-"}
              </dd>
            </dl>
          )}
        </section>
      )}

      {charger?.state === "booted" && (
        <>
          <section id="step-3" aria-labelledby="h-3">
            <h2 id="h-3">3. Test</h2>
            <div className="row">
              <label>
                Connector
                <select
                  value={testConnector}
                  onChange={(e) => setTestConnector(Number(e.target.value))}
                >
                  {charger.connectors.map((k) => (
                    <option key={k.number} value={k.number}>
                      {k.number}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={busy || !!testRunning || !!charger.inServiceAt}
                onClick={() =>
                  run(async () =>
                    setCharger(
                      await api<Charger>(`/api/chargers/${charger.id}/test`, {
                        action: "start",
                        connector: testConnector,
                      }),
                    ),
                  )
                }
              >
                Start test session
              </button>
              <button
                type="button"
                disabled={busy || !testRunning || !charger.test?.transactionId}
                onClick={() =>
                  run(async () =>
                    setCharger(
                      await api<Charger>(`/api/chargers/${charger.id}/test`, {
                        action: "stop",
                      }),
                    ),
                  )
                }
              >
                Stop test session
              </button>
            </div>
            {charger.inServiceAt && (
              <p className="muted">
                This charger is in service: test sessions are no longer allowed.
              </p>
            )}
            {demo && (
              <p className="muted">
                Demo: the start and stop are simulated, nothing is sent.
              </p>
            )}
            {charger.test && (
              <div
                className={`result ${charger.test.phase}`}
                role="status"
                aria-live="polite"
              >
                <span className="phase">
                  {charger.test.phase === "done"
                    ? "Passed"
                    : charger.test.phase === "failed"
                      ? `Failed (${charger.test.errorCode})`
                      : `Test ${charger.test.phase}…`}
                </span>
                <span className="kwh">{formatKwh(charger.test.energyWh)}</span>
                <span className="muted">
                  delivered on connector {charger.test.connectorNumber}.{" "}
                  {TEST_SESSION_LABEL}.
                  {charger.test.phase === "done" &&
                    charger.test.energyWh === 0 &&
                    " No energy: plug in a vehicle to see energy flow."}
                </span>
              </div>
            )}

            <h3>Configuration</h3>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await api<{ charger: Charger }>(
                    `/api/chargers/${charger.id}/config`,
                    { action: "read" },
                  );
                  setCharger(r.charger);
                })
              }
            >
              Read configuration
            </button>
            {charger.config && (
              <dl>
                <dt>Heartbeat interval</dt>
                <dd>{charger.config.values.HeartbeatInterval ?? "-"} s</dd>
                <dt>Meter value interval</dt>
                <dd>
                  {charger.config.values.MeterValueSampleInterval ?? "-"} s
                </dd>
              </dl>
            )}
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  const r = await api<{
                    charger: Charger;
                    chargerStatus: string;
                  }>(`/api/chargers/${charger.id}/config`, {
                    key: configKey,
                    value: Number(configValue),
                  });
                  setCharger(r.charger);
                  setConfigAnswer(r.chargerStatus);
                });
              }}
            >
              <label>
                Change
                <select
                  value={configKey}
                  onChange={(e) => setConfigKey(e.target.value as ConfigKey)}
                >
                  <option value="HeartbeatInterval">Heartbeat interval</option>
                  <option value="MeterValueSampleInterval">
                    Meter value interval
                  </option>
                </select>
              </label>
              <label>
                Seconds
                <input
                  type="number"
                  min={10}
                  max={86400}
                  value={configValue}
                  onChange={(e) => setConfigValue(e.target.value)}
                />
              </label>
              <button type="submit" className="secondary" disabled={busy}>
                Apply and read back
              </button>
            </form>
            {configAnswer && (
              <p className="muted">Charger answered {configAnswer}.</p>
            )}
          </section>

          <section id="step-4" aria-labelledby="h-4">
            <h2 id="h-4">4. Price (optional)</h2>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                run(async () =>
                  setCharger(
                    await api<Charger>(`/api/chargers/${charger.id}/tariff`, {
                      minorPerKwh: tariff,
                      currency,
                    }),
                  ),
                );
              }}
            >
              <label>
                Currency
                <select
                  value={currency}
                  onChange={(e) => setPickedCurrency(e.target.value)}
                >
                  {[...new Set([currency, ...PRICE_CURRENCIES])].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label>
                Price per kWh ({currency} minor units)
                <input
                  type="number"
                  min={0}
                  max={10000}
                  step={1}
                  value={tariff}
                  onChange={(e) =>
                    setTariff(
                      Math.max(0, Math.round(Number(e.target.value) || 0)),
                    )
                  }
                />
              </label>
              <p className="muted">
                {tariff} = {formatMinor(tariff, currency)} per kWh (1 {currency}{" "}
                = {10 ** currencyExponent(currency)} minor units).
              </p>
              <button type="submit" className="secondary" disabled={busy}>
                Add to report
              </button>
            </form>
            <p>
              Quote preview: 20 kWh costs{" "}
              <strong>
                {formatMinor(quoteMinor(20_000, tariff), currency)}
              </strong>
              {charger.test && (
                <>
                  ; the {TEST_SESSION_LABEL.toLowerCase()} (
                  {formatKwh(charger.test.energyWh)}) would cost{" "}
                  {formatMinor(
                    quoteMinor(charger.test.energyWh, tariff),
                    currency,
                  )}
                </>
              )}
              . This template does not collect payments; see forecourt-checkout.
            </p>
          </section>

          <section id="step-5" aria-labelledby="h-5">
            <h2 id="h-5">5. Hand over</h2>
            {qrProblem && (
              <p role="alert" className="error">
                Stickers are disabled: {qrProblem}
              </p>
            )}
            <div className="previews">
              {!qrProblem && (
                <figure className="sticker" aria-label="Sticker preview">
                  <p className="slot">Your logo here</p>
                  <p className="scan">Scan to charge</p>
                  <svg viewBox="0 0 24 24" width="96" height="96" role="img">
                    <title>The QR code is printed in the PDF</title>
                    <path
                      d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM19 14h2v2h-2zM14 19h2v2h-2zM18 18h3v3h-3z"
                      fill="currentColor"
                    />
                  </svg>
                  <figcaption>
                    {site?.name}, {charger.name}
                  </figcaption>
                </figure>
              )}
              <figure className="paper" aria-label="Report preview">
                <p className="scan">Commissioning report</p>
                <dl>
                  <dt>Site</dt>
                  <dd>{site?.name}</dd>
                  <dt>Charger</dt>
                  <dd>{charger.name}</dd>
                  <dt>Model</dt>
                  <dd>{charger.boot?.model ?? "-"}</dd>
                  <dt>{TEST_SESSION_LABEL}</dt>
                  <dd>{charger.test?.passed ? "Pass" : "-"}</dd>
                  <dt>In service</dt>
                  <dd>{charger.inServiceAt ?? "Not yet"}</dd>
                  <dt>Price</dt>
                  <dd>
                    {charger.tariffMinorPerKwh === undefined
                      ? "-"
                      : `${formatMinor(charger.tariffMinorPerKwh, currencyOr(charger.tariffCurrency))} / kWh`}
                  </dd>
                </dl>
              </figure>
            </div>
            <div className="row">
              <button
                type="button"
                disabled={busy || !!charger.inServiceAt || !!testRunning}
                onClick={() =>
                  run(async () =>
                    setCharger(
                      await api<Charger>(
                        `/api/chargers/${charger.id}/in-service`,
                        {},
                      ),
                    ),
                  )
                }
              >
                Mark in service
              </button>
              {charger.inServiceAt && (
                <span role="status">
                  In service since {charger.inServiceAt}. Test sessions are
                  refused.
                </span>
              )}
            </div>
            <div className="row">
              {!qrProblem &&
                charger.connectors.map((k) => (
                  <a
                    key={k.number}
                    className="button"
                    href={`/api/chargers/${charger.id}/sticker?connector=${k.number}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Sticker PDF, connector {k.number} ({k.code})
                  </a>
                ))}
              <a
                className="button"
                href={`/api/chargers/${charger.id}/report`}
                target="_blank"
                rel="noreferrer"
              >
                Commissioning report PDF
              </a>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Credentials({
  created,
  busy,
  onHide,
  onRotate,
}: {
  created: Created;
  busy: boolean;
  onHide: () => void;
  onRotate: () => void;
}) {
  const c = created.charger;
  const [shown, setShown] = useState(false);
  return (
    <>
      <dl>
        <dt>Connection URL</dt>
        <dd className="value">
          <code title={c.connectionUrl}>{c.connectionUrl}</code>
          <Copy value={c.connectionUrl} label="connection URL" />
        </dd>
        <dt>Charge point ID / user</dt>
        <dd className="value">
          <code title={c.username}>{c.username}</code>
          <Copy value={c.username} label="user" />
        </dd>
        <dt>Password</dt>
        <dd className="value">
          {created.password ? (
            <>
              <code
                data-testid="password"
                className={shown ? undefined : "masked"}
              >
                {created.password}
              </code>
              <button
                type="button"
                className="secondary"
                aria-pressed={shown}
                onClick={() => setShown(!shown)}
              >
                {shown ? "Mask" : "Reveal"}
              </button>
              <Copy value={created.password} label="password" />
              <button type="button" className="secondary" onClick={onHide}>
                Hide
              </button>
            </>
          ) : (
            <>
              <code>{c.passwordMasked}</code>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={onRotate}
              >
                Set a new password
              </button>
            </>
          )}
        </dd>
      </dl>
      {created.passwordError && <ErrorNote e={created.passwordError} />}
      {created.password && (
        <p className="muted">
          Shown once: copy it into the charger now. It cannot be displayed
          again; you can only set a new one.
        </p>
      )}
      <div className="qrs">
        <figure>
          <div
            className="qr"
            role="img"
            aria-label="QR code of the connection URL"
            dangerouslySetInnerHTML={{ __html: created.qr.url }}
          />
          <figcaption>Connection URL</figcaption>
        </figure>
        {created.qr.password && (
          <figure>
            <div
              className="qr"
              role="img"
              aria-label="QR code of the password"
              dangerouslySetInnerHTML={{ __html: created.qr.password }}
            />
            <figcaption>Password (shown once)</figcaption>
          </figure>
        )}
      </div>
    </>
  );
}
