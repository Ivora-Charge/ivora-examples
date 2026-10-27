"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { DEFAULT_CURRENCY, formatMoney } from "@/lib/money";
import type { DriverCounter } from "@/lib/server/cashier";
import { whToKwhText, wToKwText } from "@/lib/units";
import { ErrorBox, type ErrorInfo } from "./error-box";

/** The driver chose to pay at the counter: what to tell the cashier, then live status. */
export function CounterScreen(props: {
  code: string;
  connector: number;
  label: string;
}) {
  const [state, setState] = useState<DriverCounter | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);

  const poll = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/counter/${encodeURIComponent(props.code)}/${props.connector}`,
        { cache: "no-store" },
      );
      const body = await response.json();
      if (!response.ok) {
        // Busy or rate-limited: keep the last state, the next poll retries.
        if (!(body as { retry?: boolean }).retry && response.status !== 429)
          setError(body as ErrorInfo);
        return;
      }
      setError(null);
      setState(body as DriverCounter);
    } catch {
      // Offline for a moment; the next poll retries.
    }
  }, [props.code, props.connector]);

  const pollMs = state?.pollMs ?? 2000;
  useEffect(() => {
    void poll();
    const timer = setInterval(poll, pollMs);
    return () => clearInterval(timer);
  }, [poll, pollMs]);

  return <CounterStatus {...props} state={state} error={error} />;
}

/** What the counter page shows for a polled state; split out so it renders without polling. */
export function CounterStatus(props: {
  code: string;
  connector: number;
  label: string;
  state: DriverCounter | null;
  error: ErrorInfo | null;
}) {
  const { state, error } = props;
  const v = state?.sale ?? null;
  const money = (c: number | null) =>
    c === null ? "—" : formatMoney(c, v?.currency ?? DEFAULT_CURRENCY);
  const a = v?.amounts ?? null;
  const prepaid = v?.prepaidCents ?? null;

  return (
    <>
      <div className="card center" data-testid="counter-number">
        <p className="muted" style={{ margin: 0 }}>
          Pay at the counter. Tell the cashier
        </p>
        <div className="counter-label">{state?.label ?? props.label}</div>
      </div>

      {!state ? <p>Checking the charger…</p> : null}

      {state && !v ? (
        <div className="card stack">
          <h2>Waiting for the cashier</h2>
          <p style={{ margin: 0 }}>
            Plug in your car, then go to the counter. The cashier starts this
            charger once you&apos;ve prepaid, or authorises it and you pay when
            you&apos;re done.
          </p>
          <p className="muted" style={{ margin: 0 }}>
            The charger reports {state.status}.
          </p>
        </div>
      ) : null}

      {v?.phase === "starting" ? (
        <div className="card">
          <h2>Starting</h2>
          <p>{v.message ?? "The cashier has started this charger."}</p>
        </div>
      ) : null}

      {v && (v.phase === "charging" || v.phase === "settling") ? (
        <div className="card">
          <h2>Charging</h2>
          <div className="grid">
            <div>
              <div className="muted">Energy</div>
              <div className="big" data-testid="counter-energy">
                {whToKwhText(v.energyWh)} <small>kWh</small>
              </div>
            </div>
            <div>
              <div className="muted">Power</div>
              <div className="big">
                {v.powerW === null ? "—" : wToKwText(v.powerW)}{" "}
                <small>kW</small>
              </div>
            </div>
          </div>
          <p>
            Cost so far <strong>{money(v.runningCents)}</strong>
            {prepaid !== null ? (
              <span className="muted"> of {money(prepaid)} prepaid</span>
            ) : null}
          </p>
          {prepaid !== null ? (
            <p className="muted">
              Charging stops before your prepaid amount runs out. Any change is
              handed back at the counter.
            </p>
          ) : (
            <p className="muted">Pay at the counter when you&apos;re done.</p>
          )}
          {v.message ? <p>{v.message}</p> : null}
        </div>
      ) : null}

      {v?.phase === "finished" ? (
        <div className="notice" data-testid="counter-move-car">
          <strong>Charging complete.</strong> {whToKwhText(v.energyWh)} kWh.
          Please unplug and move your car. Idle fees apply after{" "}
          {state?.graceMinutes} free minutes.
        </div>
      ) : null}

      {v && (v.phase === "done" || v.phase === "canceled") && a ? (
        <div className="card stack">
          <h2>{v.phase === "canceled" ? "Canceled" : "Charging finished"}</h2>
          <p style={{ margin: 0 }}>
            {whToKwhText(v.energyWh)} kWh · total {money(a.dueCents)}
          </p>
          {a.outstandingCents > 0 ? (
            <p className="owed" data-testid="counter-due">
              Pay <strong>{money(a.outstandingCents)}</strong> at the counter.
            </p>
          ) : null}
          {a.overrunCents > 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              The session used {money(a.overrunCents)} more than you prepaid.
            </p>
          ) : null}
          {a.changeCents > 0 && !a.changeGiven ? (
            <p className="owed" data-testid="counter-change">
              Collect your change: <strong>{money(a.changeCents)}</strong>
            </p>
          ) : null}
          {a.status === "paid" ? (
            <p className="pill ok">Paid in store. Thank you!</p>
          ) : null}
          <p className="muted" style={{ margin: 0 }}>
            Ask the cashier for a printed receipt.
          </p>
        </div>
      ) : null}

      {v?.phase === "canceled" && !a ? (
        <div className="card">
          <p>{v.message ?? "The sale was canceled. Nothing was charged."}</p>
        </div>
      ) : null}

      {v?.phase === "review" ? (
        <div className="card">
          <p>Please see the cashier about this charging session.</p>
        </div>
      ) : null}

      {error ? <ErrorBox info={error} /> : null}

      {!v || v.phase === "done" || v.phase === "canceled" ? (
        <p>
          <Link
            href={`/c/${encodeURIComponent(props.code)}/${props.connector}`}
          >
            Pay here by card instead
          </Link>
        </p>
      ) : null}
      {state?.demo ? (
        <p className="muted">
          Demo: open the <Link href="/cashier">cashier console</Link> to play
          the cashier (password: demo).
        </p>
      ) : null}
    </>
  );
}
