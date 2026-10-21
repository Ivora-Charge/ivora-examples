"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatCents } from "@/lib/money";
import { formatDuration, whToKwhText, wToKwText } from "@/lib/units";
import type { SessionView } from "@/lib/view";
import { ErrorBox, type ErrorInfo } from "./error-box";
import { ReceiptTable } from "./receipt-table";

const TERMINAL = new Set(["completed", "canceled", "review"]);

export function SessionScreen({
  id,
  initial,
}: {
  id: string;
  initial: SessionView | null;
}) {
  const [view, setView] = useState<SessionView | null>(initial);
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const sessionId = useRef(id);

  const accept = useCallback((next: SessionView) => {
    setView(next);
    setReceivedAt(Date.now());
    if (next.id !== sessionId.current) {
      // Demo sessions carry their state in the ID; keep the address bar in step.
      sessionId.current = next.id;
      window.history.replaceState(null, "", `/s/${next.id}`);
    }
  }, []);

  const poll = useCallback(async () => {
    try {
      const response = await fetch(`/api/sessions/${sessionId.current}`, {
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) {
        if (!(body as ErrorInfo & { retry?: boolean }).retry)
          setError(body as ErrorInfo);
        return;
      }
      setError(null);
      accept(body as SessionView);
    } catch {
      // Offline for a moment; the next poll retries.
    }
  }, [accept]);

  const terminal = view ? TERMINAL.has(view.phase) : false;
  const demo = view?.demo ?? id.startsWith("demo.");
  useEffect(() => {
    if (terminal) return;
    void poll();
    const timer = setInterval(poll, demo ? 1000 : 4000);
    return () => clearInterval(timer);
  }, [poll, terminal, demo]);

  useEffect(() => {
    if (view?.phase !== "finished" && view?.phase !== "charging") return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [view?.phase]);

  async function act(action: "stop" | "unplug") {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/sessions/${sessionId.current}/${action}`,
        { method: "POST" },
      );
      const body = await response.json();
      if (!response.ok) setError(body as ErrorInfo);
      else accept(body as SessionView);
    } finally {
      setBusy(false);
    }
  }

  if (!view)
    return (
      <main>
        <h1>Loading your session…</h1>
        {error ? null : (
          <div className="skeleton card-skel" aria-hidden="true" />
        )}
        {error ? <ErrorBox info={error} /> : null}
      </main>
    );

  const money = (cents: number | null) =>
    cents === null ? "—" : formatCents(cents, view.currency);
  const elapsed = view.startedAt
    ? (now - Date.parse(view.startedAt)) / 1000
    : 0;
  const share =
    view.runningCents && view.holdCents
      ? Math.min(100, (view.runningCents / view.holdCents) * 100)
      : 0;

  return (
    <main>
      <p className="muted" style={{ marginBottom: 0 }}>
        {view.charger.name} · connector {view.charger.connector}
      </p>
      {view.phase === "payment" && (
        <>
          <h1>Finish paying to start</h1>
          <div className="card stack">
            {view.checkoutUrl ? (
              <a className="button block" href={view.checkoutUrl}>
                Continue to payment
              </a>
            ) : null}
            <button
              className="secondary block"
              disabled={busy}
              onClick={() => act("stop")}
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {view.phase === "starting" && (
        <>
          <h1>Starting…</h1>
          <div className="card stack">
            <p style={{ margin: 0 }}>
              {view.message ??
                "Your card hold is authorized. Starting the charger."}
            </p>
            <p className="muted" style={{ margin: 0 }}>
              Hold: {money(view.holdCents)}. Plug in your car if you
              haven&apos;t yet.
            </p>
            {view.canStop ? (
              <button
                className="secondary block"
                disabled={busy}
                onClick={() => act("stop")}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </>
      )}

      {view.phase === "charging" && (
        <>
          <h1>Charging</h1>
          <div className="card">
            <div className="grid">
              <div>
                <div className="muted">Energy</div>
                <div className="big" data-testid="energy">
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
            </div>
            <p>
              Running cost{" "}
              <strong data-testid="running-cost">
                {money(view.runningCents)}
              </strong>
              {view.startedAt ? (
                <span className="muted">
                  {" "}
                  · {formatDuration(elapsed * view.speed)}
                </span>
              ) : null}
            </p>
            <div className="meter" aria-label="Share of your card hold used">
              <span style={{ width: `${share}%` }} />
            </div>
            <p className="muted">
              Charging stops automatically before it reaches your{" "}
              {money(view.holdCents)} hold.
            </p>
            {view.message ? <p>{view.message}</p> : null}
            {view.canStop ? (
              <button
                className="danger block"
                disabled={busy}
                onClick={() => act("stop")}
              >
                Stop charging
              </button>
            ) : null}
          </div>
        </>
      )}

      {view.phase === "finished" && view.idle && (
        <Finished
          view={view}
          receivedAt={receivedAt}
          now={now}
          busy={busy}
          act={act}
        />
      )}

      {view.phase === "settling" && (
        <>
          <h1>Charging finished</h1>
          <div className="card">
            <p>{view.message ?? "Preparing your receipt…"}</p>
            <p className="muted">
              {whToKwhText(view.energyWh)} kWh delivered. Please move your car
              so the next driver can charge.
            </p>
          </div>
        </>
      )}

      {view.phase === "completed" && view.receipt && (
        <>
          <h1>Receipt</h1>
          {view.message ? <div className="notice">{view.message}</div> : null}
          <div className="card">
            <p className="muted" style={{ marginTop: 0 }}>
              {whToKwhText(view.receipt.energyWh)} kWh
              {view.receipt.idleSeconds > 0
                ? ` · ${Math.round(view.receipt.idleSeconds / 60)} min idle`
                : ""}
            </p>
            <ReceiptTable receipt={view.receipt} />
            <p>
              <Link href={`/s/${view.id}/receipt`}>Printable receipt</Link>
            </p>
          </div>
        </>
      )}

      {view.phase === "canceled" && (
        <>
          <h1>No charge</h1>
          <div className="card">
            <p>
              {view.message ??
                "The session was canceled and your hold was released."}
            </p>
            <Link href={`/c/${view.charger.code}/${view.charger.connector}`}>
              Back to the charger
            </Link>
          </div>
        </>
      )}

      {view.phase === "review" && (
        <>
          <h1>Needs attention</h1>
          <div className="card">
            <p>{view.message}</p>
          </div>
          {view.error ? (
            <ErrorBox
              info={{
                error: view.error.code,
                message: view.error.message,
                requestId: view.error.requestId,
              }}
              title="What happened"
            />
          ) : null}
        </>
      )}

      {error ? <ErrorBox info={error} /> : null}
      {view.demo ? (
        <p className="muted">Demo session · time runs {view.speed}× faster.</p>
      ) : null}
    </main>
  );
}

function Finished(props: {
  view: SessionView;
  receivedAt: number;
  now: number;
  busy: boolean;
  act: (a: "stop" | "unplug") => void;
}) {
  const { view } = props;
  const idle = view.idle!;
  // Interpolate between polls so the countdown ticks smoothly.
  const passed = ((props.now - props.receivedAt) / 1000) * view.speed;
  const left = Math.max(0, idle.secondsUntilFee - passed);
  const perMinute = Math.round(idle.idleCentsPerHour / 60);
  return (
    <>
      <h1>Please move your car</h1>
      <div className="notice" data-testid="move-car">
        <p style={{ marginTop: 0 }}>
          <strong>Charging is complete.</strong> {whToKwhText(view.energyWh)}{" "}
          kWh delivered.
        </p>
        {perMinute > 0 ? (
          left > 0 ? (
            <>
              <div className="muted">
                Idle fee of {formatCents(perMinute, view.currency)}/min starts
                in
              </div>
              <div className="countdown" data-testid="idle-countdown">
                {formatDuration(left)}
              </div>
            </>
          ) : (
            <>
              <div className="muted">
                Idle fee is now {formatCents(perMinute, view.currency)}/min
                until you unplug.
              </div>
              <div className="countdown">
                {formatCents(idle.accruedCents, view.currency)} so far
              </div>
            </>
          )
        ) : (
          <p>Other drivers are waiting to charge.</p>
        )}
      </div>
      <div className="card stack">
        <p style={{ margin: 0 }}>
          Running total{" "}
          <strong>{formatCents(view.runningCents ?? 0, view.currency)}</strong>
        </p>
        {view.demo ? (
          <button
            className="block"
            disabled={props.busy}
            onClick={() => props.act("unplug")}
          >
            Unplug car (demo)
          </button>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            Unplug your car to end the session. Your receipt appears here.
          </p>
        )}
        {view.canStop ? (
          <button
            className="secondary block"
            disabled={props.busy}
            onClick={() => props.act("stop")}
          >
            End session
          </button>
        ) : null}
      </div>
    </>
  );
}
