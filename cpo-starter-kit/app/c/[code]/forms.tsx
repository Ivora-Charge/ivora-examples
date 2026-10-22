"use client";

import { useActionState, useEffect, useState } from "react";
import { EMPTY, type ActionState } from "@/lib/action-state";
import { payAction, startAction } from "./actions";

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

/**
 * "Pay and charge". The request ID comes from the server with the page and stays the
 * same until the page is reloaded, so a double tap or a retry after an uncertain answer
 * continues the same checkout: one bill, one payment.
 */
export function PayForm(p: {
  code: string;
  requestId: string;
  hold: string;
  /** Why paying is off right now (shown above), or null. */
  closed: boolean;
  demo: boolean;
}) {
  const [state, action, pending] = useActionState(payAction, EMPTY);
  // A refresh of the page must not start a new checkout, and a retry after an
  // uncertain answer continues this one. After a definite refusal (that checkout is
  // closed), the next tap starts a new one.
  const [requestId, setRequestId] = useState(p.requestId);
  useEffect(() => {
    if (state.errorDetail && !CONTINUE.has(state.errorDetail.kind))
      setRequestId(crypto.randomUUID());
  }, [state]);
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
              ? `Pay and charge with a demo card (${p.hold} hold)`
              : `Pay and charge (${p.hold} hold)`}
      </button>
      <DriverError state={state} />
    </form>
  );
}

/** Starts this browser's paid session when Ivora's automatic start was refused. */
export function StartForm(p: { code: string; id: string }) {
  const [state, action, pending] = useActionState(startAction, EMPTY);
  return (
    <form action={action} className="form">
      <input type="hidden" name="code" value={p.code} />
      <input type="hidden" name="id" value={p.id} />
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
