"use client";

import { useActionState, useEffect, useState } from "react";
import { EMPTY, type ActionState } from "@/lib/action-state";
import { freeAction, payAction, startAction, stopAction } from "./actions";

const ERRORS_URL = "https://ivoracharge.com/developers/guides/reference/errors";

/** Errors after which "Pay and charge" continues the same checkout (same keys). */
const CONTINUE = new Set(["unconfirmed", "unavailable", "rate_limited"]);

/**
 * A driver-facing error: what happened and what to do next, then the codes small for
 * support. Never a bare "something went wrong". (From forecourt-checkout's ErrorBox.)
 */
export function DriverError({
  state,
  title = "That didn't work",
}: {
  state: ActionState;
  title?: string;
}) {
  if (!state.error) return null;
  const d = state.errorDetail;
  return (
    <div className="error driver-error" role="alert">
      <strong>{title}</strong>
      <p>{state.error}</p>
      {d && (
        <p className="muted">
          Code <code>{d.apiCode ?? d.kind}</code>
          {d.requestId && (
            <>
              {" "}
              · request <code>{d.requestId}</code>
            </>
          )}
          {d.apiCode && (
            <>
              {" "}
              · <a href={ERRORS_URL}>Errors and statuses</a>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** A new request ID after a definite refusal (that tap's session is closed). */
function useRequestId(initial: string, state: ActionState) {
  const [requestId, setRequestId] = useState(initial);
  useEffect(() => {
    if (state.errorDetail && !CONTINUE.has(state.errorDetail.kind))
      setRequestId(crypto.randomUUID());
  }, [state]);
  return requestId;
}

/**
 * "Pay and charge". The request ID comes from the server with the page and stays the
 * same until the page is reloaded, so a double tap or a retry after an uncertain answer
 * continues the same checkout: one bill, one payment.
 */
export function PayForm(p: {
  code: string;
  requestId: string;
  hold: string | null;
  /** Why paying is off right now (shown above), or null. */
  closed: boolean;
  demo: boolean;
}) {
  const [state, action, pending] = useActionState(payAction, EMPTY);
  // A refresh of the page must not start a new checkout, and a retry after an
  // uncertain answer continues this one. After a definite refusal (that checkout is
  // closed), the next tap starts a new one.
  const requestId = useRequestId(p.requestId, state);
  const hold = p.hold ? ` (${p.hold} hold)` : "";
  return (
    <form action={action} className="form pay-form">
      <input type="hidden" name="code" value={p.code} />
      <input type="hidden" name="requestId" value={requestId} />
      <button
        type="submit"
        className="button block"
        disabled={pending || p.closed}
      >
        {p.closed
          ? "Not available right now"
          : pending
            ? "Opening payment…"
            : p.demo
              ? `Pay and charge with a demo card${hold}`
              : `Pay and charge${hold}`}
      </button>
      <DriverError state={state} />
    </form>
  );
}

/** "Start free session": no payment; the same tap repeats an unconfirmed start. */
export function FreeForm(p: {
  code: string;
  requestId: string;
  closed: boolean;
}) {
  const [state, action, pending] = useActionState(freeAction, EMPTY);
  const requestId = useRequestId(p.requestId, state);
  return (
    <form action={action} className="form pay-form">
      <input type="hidden" name="code" value={p.code} />
      <input type="hidden" name="requestId" value={requestId} />
      <button
        type="submit"
        className="button block"
        disabled={pending || p.closed}
      >
        {p.closed
          ? "Not available right now"
          : pending
            ? "Starting…"
            : "Start free session"}
      </button>
      <DriverError state={state} title="The session didn't start" />
      {state.ok && (
        <p className="success" role="status">
          {state.ok}
        </p>
      )}
    </form>
  );
}

/** Starts this browser's paid session when Ivora's automatic start was refused. */
export function StartForm(p: { code: string; requestId: string }) {
  const [state, action, pending] = useActionState(startAction, EMPTY);
  return (
    <form action={action} className="form">
      <input type="hidden" name="code" value={p.code} />
      <input type="hidden" name="requestId" value={p.requestId} />
      <button type="submit" className="button" disabled={pending}>
        {pending ? "Starting…" : "Start charging"}
      </button>
      <DriverError state={state} title="The charger didn't start" />
      {state.ok && (
        <p className="success" role="status">
          {state.ok}
        </p>
      )}
    </form>
  );
}

/** Stops this browser's own running session. */
export function StopForm(p: { code: string; requestId: string }) {
  const [state, action, pending] = useActionState(stopAction, EMPTY);
  return (
    <form action={action} className="form">
      <input type="hidden" name="code" value={p.code} />
      <input type="hidden" name="requestId" value={p.requestId} />
      <button type="submit" className="button secondary" disabled={pending}>
        {pending ? "Stopping…" : "Stop charging"}
      </button>
      <DriverError state={state} title="The charger didn't stop" />
      {state.ok && (
        <p className="success" role="status">
          {state.ok}
        </p>
      )}
    </form>
  );
}
