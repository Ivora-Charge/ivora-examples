"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatCents } from "@/lib/money";
import type { ConsoleState, SimulatedPos } from "@/lib/server/store";
import {
  parseDollars,
  parseKwh,
  TILE_LABELS,
  type PaymentMethod,
  type SaleView,
  type Tile,
} from "@/lib/store";
import { whToKwhText, wToKwText } from "@/lib/units";
import { ErrorBox, type ErrorInfo } from "./error-box";

const QUICK_AMOUNTS = [1000, 2000, 3000, 5000];

async function call(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok)
    throw (
      (json as ErrorInfo) ?? {
        error: "http_error",
        message: `Request failed (${response.status}).`,
      }
    );
  return json;
}

const asError = (e: unknown): ErrorInfo =>
  (e as ErrorInfo)?.error
    ? (e as ErrorInfo)
    : {
        error: "network_error",
        message: "Check the connection and try again.",
      };

/** Most sale IDs the console sends back on a poll (MAX_KNOWN_SALES on the server). */
const MAX_KNOWN = 24;

export function CashierConsole({ initial }: { initial: ConsoleState | null }) {
  const [state, setState] = useState<ConsoleState | null>(initial);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Sales this console has shown or started. Each poll names them, so a
  // server instance that hasn't seen a sale yet looks it up by reference.
  const known = useRef<string[]>([]);
  const remember = (sales: string[]) => {
    known.current = [...new Set([...sales, ...known.current])].slice(
      0,
      MAX_KNOWN,
    );
  };

  const poll = useCallback(async (sale?: string) => {
    if (typeof sale === "string") remember([sale]);
    const query = known.current.length
      ? `?sales=${encodeURIComponent(known.current.join(","))}`
      : "";
    try {
      const response = await fetch(`/api/cashier/state${query}`, {
        cache: "no-store",
      });
      const body = await response.json();
      if (response.status === 401) {
        window.location.assign("/cashier/login");
        return;
      }
      if (!response.ok) {
        if (!(body as { retry?: boolean }).retry) setError(body as ErrorInfo);
        return;
      }
      setError(null);
      const next = body as ConsoleState;
      remember([
        ...next.tiles.flatMap((t) => (t.sale ? [t.sale.sale] : [])),
        ...next.unpaid.map((v) => v.sale),
      ]);
      setState(next);
    } catch {
      // Offline for a moment; the next poll retries.
    }
  }, []);

  const pollMs = state?.pollMs ?? 3000;
  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), pollMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [poll, pollMs]);

  if (!state)
    return (
      <>
        <p>Loading chargers…</p>
        {error ? <ErrorBox info={error} /> : null}
      </>
    );

  const tile = state.tiles.find((t) => t.key === selected) ?? null;
  return (
    <>
      {error ? <ErrorBox info={error} title="Could not refresh" /> : null}
      {state.truncated ? (
        <div className="notice bad" role="alert" data-testid="truncated">
          This Ivora project has more charging sessions than the console reads
          (10,000). A sale may be missing here: check the charger itself before
          starting another, and see Limits in the README.
        </div>
      ) : null}
      <div className="pumps" role="list" aria-label="Chargers">
        {state.tiles.map((t) => (
          <TileButton
            key={t.key}
            tile={t}
            selected={t.key === selected}
            onSelect={() => setSelected(t.key === selected ? null : t.key)}
          />
        ))}
      </div>
      {tile ? (
        <TilePanel
          key={tile.key}
          tile={tile}
          graceMinutes={state.graceMinutes}
          refresh={poll}
          close={() => setSelected(null)}
        />
      ) : (
        <p className="muted">
          Tap a charger to authorise, stop or take payment.
        </p>
      )}
      {state.unpaid.length ? (
        <section className="card" aria-label="Unpaid sales">
          <h2>Unpaid sales</h2>
          {state.unpaid.map((v) => (
            <div key={v.sale} className="unpaid-row">
              <SaleSummary view={v} />
              <PaymentActions view={v} refresh={poll} />
            </div>
          ))}
        </section>
      ) : null}
      {state.pos ? <SimulatedPosPanel pos={state.pos} refresh={poll} /> : null}
    </>
  );
}

/**
 * Demo only: a store POS as the integration would see it. It shows the signed
 * session_due webhooks the live app would send, and pays through
 * /api/pos/mark-paid with a bearer token, like a real POS.
 */
function SimulatedPosPanel({
  pos,
  refresh,
}: {
  pos: SimulatedPos;
  refresh: (sale?: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [last, setLast] = useState<string | null>(null);

  async function pay(
    d: SimulatedPos["deliveries"][number],
    method: PaymentMethod,
  ) {
    setBusy(d.eventId);
    setError(null);
    try {
      const response = await fetch("/api/pos/mark-paid", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${pos.apiSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sale_id: d.sale,
          amount_minor: d.amountDueCents,
          method,
          pos_reference: "SIM-2001",
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw body;
      setLast(JSON.stringify(body, null, 2));
      await refresh();
    } catch (e) {
      setError(asError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card" aria-label="Simulated POS">
      <h2>Simulated POS (demo)</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        What a store POS integration receives: a signed <code>session_due</code>{" "}
        webhook to <code>{pos.url}</code> for each sale the counter must settle.
        Demo mode sends nothing; this panel shows each webhook and pays through{" "}
        <code>POST /api/pos/mark-paid</code>, as a POS would.
      </p>
      {pos.deliveries.length === 0 ? (
        <p className="muted">No sales due at the counter.</p>
      ) : null}
      {pos.deliveries.map((d) => {
        const money = (c: number) => formatCents(c, d.currency);
        return (
          <div key={d.eventId} className="pos-event" data-testid="pos-event">
            <div>
              <strong>{d.label}</strong> · <code>session_due</code> ·{" "}
              {d.verified ? "signature verified" : "signature invalid"}
            </div>
            <div>
              {d.amountDueCents > 0
                ? `Due ${money(d.amountDueCents)}`
                : `Change to hand back ${money(d.changeDueCents)} (at the console)`}
            </div>
            <details>
              <summary>Webhook received</summary>
              <pre>{`POST ${pos.url}\n${d.header}\n${d.signature}\n\n${d.body}`}</pre>
            </details>
            {d.amountDueCents > 0 ? (
              <div className="row">
                {(["cash", "card"] as const).map((m) => (
                  <button
                    key={m}
                    className="secondary"
                    disabled={busy !== null}
                    onClick={() => pay(d, m)}
                  >
                    POS: {d.label} paid {money(d.amountDueCents)} ({m})
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
      {last ? (
        <details open>
          <summary>Last mark-paid answer</summary>
          <pre data-testid="pos-result">{last}</pre>
        </details>
      ) : null}
      {error ? <ErrorBox info={error} /> : null}
    </section>
  );
}

function headline(t: Tile) {
  const v = t.sale;
  const money = (c: number | null) =>
    c === null ? "—" : formatCents(c, v?.currency ?? "USD");
  if (t.state === "charging" && v)
    return `${whToKwhText(v.energyWh)} kWh · ${money(v.runningCents)}`;
  if (t.state === "done_unpaid" && v?.amounts) {
    const a = v.amounts;
    if (a.outstandingCents > 0)
      return v.terms.mode === "prepay"
        ? `Extra due ${money(a.outstandingCents)}`
        : `Due ${money(a.outstandingCents)}`;
    if (a.changeCents > 0 && !a.changeGiven)
      return `Change ${money(a.changeCents)}`;
  }
  if (t.state === "done_unpaid" && v?.phase === "review") return "Needs review";
  if (t.state === "paid" && v?.amounts)
    return `${money(v.amounts.dueCents)} paid`;
  if (t.state === "starting") return "Starting…";
  if (t.state === "plugged_in") return "Waiting for you";
  return t.connectorLabel;
}

function TileButton({
  tile,
  selected,
  onSelect,
}: {
  tile: Tile;
  selected: boolean;
  onSelect: () => void;
}) {
  const v = tile.sale;
  return (
    <button
      role="listitem"
      className={`pump state-${tile.state}${selected ? " selected" : ""}`}
      aria-label={`${tile.label}: ${TILE_LABELS[tile.state]}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="pump-label">{tile.label}</span>
      <span className="pump-state">{TILE_LABELS[tile.state]}</span>
      <span className="pump-line">{headline(tile)}</span>
      {v && v.terms.mode === "prepay" && tile.state === "charging" ? (
        <span className="pump-line small">
          prepaid {formatCents(v.terms.prepaidCents ?? 0, v.currency)}
        </span>
      ) : null}
      {tile.warning ? <span className="pump-warn">⚠ Check charger</span> : null}
      {v?.stopProblem ? (
        <span className="pump-warn">
          ⚠ {v.stopProblem === "failed" ? "Stop failed" : "Stop not confirmed"}:
          stop it at the charger
        </span>
      ) : null}
    </button>
  );
}

function TilePanel({
  tile,
  graceMinutes,
  refresh,
  close,
}: {
  tile: Tile;
  graceMinutes: number;
  refresh: (sale?: string) => Promise<void>;
  close: () => void;
}) {
  const v = tile.sale;
  return (
    <section className="card panel" aria-label={tile.label}>
      <div className="panel-head">
        <div>
          <h2 style={{ marginBottom: 0 }}>{tile.label}</h2>
          <div className="muted">
            {tile.stationName} · {tile.connectorLabel} · charger reports{" "}
            {tile.status}
          </div>
        </div>
        <button className="secondary" onClick={close}>
          Close
        </button>
      </div>
      {tile.warning ? (
        <div className="notice bad" role="alert">
          {tile.warning}
        </div>
      ) : null}
      {tile.state === "card" ? (
        <p>The driver is paying by card at the charger. Nothing to do here.</p>
      ) : null}
      {v ? (
        <SalePanel view={v} graceMinutes={graceMinutes} refresh={refresh} />
      ) : null}
      {tile.canPostpay ? <Postpay tile={tile} refresh={refresh} /> : null}
      {tile.canPrepay ? <Prepay tile={tile} refresh={refresh} /> : null}
      {!v && !tile.canPrepay && !tile.canPostpay && tile.state !== "card" ? (
        <p className="muted">
          {tile.state === "offline"
            ? "This charger is offline."
            : tile.state === "faulted"
              ? "This charger reports a fault. See the operator Faults page."
              : "Nothing to do on this charger right now."}
        </p>
      ) : null}
    </section>
  );
}

/** One request ID per authorisation, reused when the same one is retried. */
function useRequestId() {
  const ref = useRef<{ key: string; id: string } | null>(null);
  return {
    get(key: string) {
      if (ref.current?.key !== key)
        ref.current = { key, id: crypto.randomUUID() };
      return ref.current.id;
    },
    done() {
      ref.current = null;
    },
  };
}

function Postpay({
  tile,
  refresh,
}: {
  tile: Tile;
  refresh: (sale?: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const ids = useRequestId();
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const view = (await call("/api/cashier/sales", {
        code: tile.code,
        connector: tile.connector,
        mode: "postpay",
        requestId: ids.get(`${tile.key}|postpay`),
      })) as SaleView;
      ids.done();
      await refresh(view.sale);
    } catch (e) {
      setError(asError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack action-block">
      <h3>Pay after charging</h3>
      <p className="muted" style={{ margin: 0 }}>
        The car is plugged in. Authorise it and the driver pays here when
        they&apos;re done, idle fees included.
      </p>
      <button className="block" disabled={busy} onClick={go}>
        {busy ? "Authorising…" : "Authorise: pay after charging"}
      </button>
      {error ? <ErrorBox info={error} /> : null}
    </div>
  );
}

function Prepay({
  tile,
  refresh,
}: {
  tile: Tile;
  refresh: (sale?: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [kwh, setKwh] = useState("");
  const [limitWh, setLimitWh] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const ids = useRequestId();
  const cents = parseDollars(amount);

  async function priceKwh() {
    const wh = parseKwh(kwh);
    if (!wh) {
      setError({ error: "invalid_kwh", message: "Enter the kWh to sell." });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const q = await call("/api/cashier/quote", {
        code: tile.code,
        connector: tile.connector,
        energyWh: wh,
      });
      setAmount((q.totalCents / 100).toFixed(2));
      setLimitWh(wh);
    } catch (e) {
      setError(asError(e));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!cents) return;
    setBusy(true);
    setError(null);
    try {
      const view = (await call("/api/cashier/sales", {
        code: tile.code,
        connector: tile.connector,
        mode: "prepay",
        prepaidCents: cents,
        limitWh,
        requestId: ids.get(`${tile.key}|prepay|${cents}|${limitWh ?? 0}`),
      })) as SaleView;
      ids.done();
      setConfirming(false);
      await refresh(view.sale);
    } catch (e) {
      setError(asError(e));
    } finally {
      setBusy(false);
    }
  }

  if (confirming && cents)
    return (
      <div className="stack action-block notice">
        <h3>Confirm the prepayment</h3>
        <p style={{ margin: 0 }}>
          Take <strong>{formatCents(cents)}</strong> on the POS for {tile.label}
          {limitWh ? ` (${whToKwhText(limitWh)} kWh)` : ""}, then confirm.
          Charging stops before the prepaid amount runs out; any change shows
          here when it ends.
        </p>
        <button className="block" disabled={busy} onClick={start}>
          {busy ? "Starting…" : `Confirm ${formatCents(cents)} paid and start`}
        </button>
        <button
          className="secondary block"
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          Back
        </button>
        {error ? <ErrorBox info={error} /> : null}
      </div>
    );

  return (
    <div className="stack action-block">
      <h3>Prepay</h3>
      <div className="quick">
        {QUICK_AMOUNTS.map((c) => (
          <button
            key={c}
            className="secondary"
            onClick={() => {
              setAmount((c / 100).toFixed(2));
              setLimitWh(null);
            }}
          >
            {formatCents(c)}
          </button>
        ))}
      </div>
      <label>
        Prepaid amount ($)
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setLimitWh(null);
          }}
          placeholder="20.00"
        />
      </label>
      <div className="row">
        <label style={{ flex: 1 }}>
          Or sell energy (kWh)
          <input
            inputMode="decimal"
            value={kwh}
            onChange={(e) => setKwh(e.target.value)}
            placeholder="25"
          />
        </label>
        <button className="secondary" disabled={busy} onClick={priceKwh}>
          Price it
        </button>
      </div>
      {limitWh ? (
        <p className="muted" style={{ margin: 0 }}>
          Stops at about {whToKwhText(limitWh)} kWh (up to half a minute of
          charging early). The amount only acts as a safety cap; anything unused
          is handed back as change.
        </p>
      ) : null}
      <button
        className="block"
        disabled={!cents || busy}
        onClick={() => setConfirming(true)}
      >
        {cents ? `Start prepaid ${formatCents(cents)}` : "Enter an amount"}
      </button>
      {error ? <ErrorBox info={error} /> : null}
    </div>
  );
}

function SalePanel({
  view,
  graceMinutes,
  refresh,
}: {
  view: SaleView;
  graceMinutes: number;
  refresh: (sale?: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const money = (c: number | null) =>
    c === null ? "—" : formatCents(c, view.currency);
  const prepaid = view.terms.prepaidCents;
  const over =
    prepaid !== null && view.runningCents !== null
      ? view.runningCents - prepaid
      : 0;

  async function act(action: "stop" | "unplug") {
    setBusy(true);
    setError(null);
    try {
      await call(`/api/cashier/sales/${view.sale}/${action}`);
      await refresh();
    } catch (e) {
      setError(asError(e));
    } finally {
      setBusy(false);
    }
  }

  const active = ["starting", "charging", "finished", "settling"].includes(
    view.phase,
  );
  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        {view.terms.mode === "prepay"
          ? `Prepaid ${money(prepaid)}${view.terms.limitWh ? ` · limit ${whToKwhText(view.terms.limitWh)} kWh` : ""}`
          : "Pay after charging"}{" "}
        · sale <code>{view.sale}</code>
      </p>
      {active && view.phase !== "starting" ? (
        <div className="grid">
          <div>
            <div className="muted">Energy</div>
            <div className="big" data-testid="sale-energy">
              {whToKwhText(view.energyWh)} <small>kWh</small>
            </div>
          </div>
          <div>
            <div className="muted">Power</div>
            <div className="big">
              {view.powerW === null ? "—" : wToKwText(view.powerW)}{" "}
              <small>kW</small>
            </div>
          </div>
          <div>
            <div className="muted">Cost so far</div>
            <div className="big" data-testid="sale-cost">
              {money(view.runningCents)}
            </div>
          </div>
        </div>
      ) : null}
      {active && over > 0 ? (
        <div className="notice bad" role="alert">
          Used {money(over)} more than prepaid.
        </div>
      ) : null}
      {view.stopProblem ? (
        <div className="notice bad" role="alert" data-testid="stop-problem">
          <strong>{view.message}</strong>
        </div>
      ) : view.message ? (
        <p style={{ margin: 0 }}>{view.message}</p>
      ) : null}
      {view.phase === "finished" ? (
        <p className="muted" style={{ margin: 0 }}>
          Idle fees apply after {graceMinutes} free minutes.
        </p>
      ) : null}
      {view.error ? (
        <ErrorBox
          info={{
            error: view.error.code,
            message: view.error.message,
            requestId: view.error.requestId,
          }}
          title="Needs attention"
        />
      ) : null}
      {view.demo && view.phase === "finished" ? (
        <button className="block" disabled={busy} onClick={() => act("unplug")}>
          Unplug car (demo)
        </button>
      ) : null}
      {view.canStop ? (
        <button
          className="danger block"
          disabled={busy}
          onClick={() => act("stop")}
        >
          {view.phase === "starting" ? "Cancel" : "Stop charging"}
        </button>
      ) : null}
      {view.amounts ? (
        <>
          <SaleSummary view={view} />
          <PaymentActions view={view} refresh={refresh} />
        </>
      ) : null}
      {error ? <ErrorBox info={error} /> : null}
    </div>
  );
}

/** The final bill and what the counter owes or is owed. */
export function SaleSummary({ view }: { view: SaleView }) {
  const a = view.amounts;
  if (!a) return null;
  const money = (c: number) => formatCents(c, view.currency);
  return (
    <div data-testid="sale-summary">
      <table>
        <tbody>
          <tr>
            <td>
              {view.charger.label}
              <div className="muted">
                {whToKwhText(view.energyWh)} kWh
                {view.phase === "canceled" ? " · canceled" : ""}
              </div>
            </td>
            <td className="num">
              {view.bill ? money(view.bill.billTotalCents) : "—"}
            </td>
          </tr>
          {view.bill && view.bill.graceCreditCents > 0 ? (
            <tr>
              <td>Idle grace</td>
              <td className="num">−{money(view.bill.graceCreditCents)}</td>
            </tr>
          ) : null}
          <tr className="total">
            <td>Total</td>
            <td className="num">{money(a.dueCents)}</td>
          </tr>
          {view.terms.mode === "prepay" ? (
            <tr>
              <td>Prepaid</td>
              <td className="num">{money(a.prepaidCents)}</td>
            </tr>
          ) : null}
          {a.payments
            .filter((p) => p.step !== "prepaid")
            .map((p, i) => (
              <tr key={i}>
                <td>
                  Paid in store ({p.method})
                  {p.posReference ? ` · ${p.posReference}` : ""}
                </td>
                <td className="num">{money(p.amountCents)}</td>
              </tr>
            ))}
        </tbody>
      </table>
      {a.changeCents > 0 ? (
        <p className="owed" data-testid="change">
          {a.changeGiven ? "Change given" : "Change owed"}:{" "}
          <strong>{money(a.changeCents)}</strong>
        </p>
      ) : null}
      {a.overrunCents > 0 ? (
        <div className="notice bad" role="alert" data-testid="overrun">
          Used {money(a.overrunCents)} more than prepaid.{" "}
          {a.outstandingCents > 0
            ? `Extra due ${money(a.outstandingCents)}: collect it if you choose, then mark it paid. It is never charged automatically.`
            : "The extra was paid."}
        </div>
      ) : null}
      {view.terms.mode === "postpay" && a.outstandingCents > 0 ? (
        <p className="owed" data-testid="amount-due">
          Amount due: <strong>{money(a.outstandingCents)}</strong>
        </p>
      ) : null}
      {a.status === "paid" ? (
        <p className="pill ok" data-testid="paid">
          Paid in store
        </p>
      ) : null}
      {!a.prepaidRecorded ? (
        <p className="muted">Recording the prepaid amount in Ivora…</p>
      ) : null}
    </div>
  );
}

function PaymentActions({
  view,
  refresh,
}: {
  view: SaleView;
  refresh: (sale?: string) => Promise<void>;
}) {
  const a = view.amounts!;
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [pos, setPos] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const money = (c: number) => formatCents(c, view.currency);

  async function run(action: "paid" | "change") {
    setBusy(true);
    setError(null);
    try {
      await call(
        `/api/cashier/sales/${view.sale}/${action}`,
        action === "paid"
          ? {
              amountCents: a.outstandingCents,
              method,
              posReference: pos.trim() || null,
            }
          : undefined,
      );
      await refresh();
    } catch (e) {
      setError(asError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {a.outstandingCents > 0 ? (
        <div className="stack action-block">
          <div className="row" role="radiogroup" aria-label="Payment method">
            {(["cash", "card"] as const).map((m) => (
              <label key={m} className="choice">
                <input
                  type="radio"
                  name={`method-${view.sale}`}
                  checked={method === m}
                  onChange={() => setMethod(m)}
                />{" "}
                {m === "cash" ? "Cash" : "Card on POS"}
              </label>
            ))}
          </div>
          <label>
            POS reference (optional)
            <input
              value={pos}
              maxLength={40}
              onChange={(e) => setPos(e.target.value)}
              placeholder="e.g. 1042"
            />
          </label>
          <button className="block" disabled={busy} onClick={() => run("paid")}>
            {view.terms.mode === "prepay"
              ? `Mark extra ${money(a.outstandingCents)} paid`
              : `Mark ${money(a.outstandingCents)} paid`}
          </button>
        </div>
      ) : null}
      {a.changeCents > 0 && !a.changeGiven ? (
        <button className="block" disabled={busy} onClick={() => run("change")}>
          {`Change given ${money(a.changeCents)}`}
        </button>
      ) : null}
      {view.phase === "done" ? (
        <Link
          className="button secondary block"
          href={`/cashier/receipt/${view.sale}`}
        >
          Print receipt
        </Link>
      ) : null}
      {error ? <ErrorBox info={error} /> : null}
    </div>
  );
}
