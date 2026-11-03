"use client";

import { useActionState } from "react";
import { EMPTY } from "@/lib/action-state";
import { DriverError } from "../../c/[code]/forms";
import { startSessionAction, stopSessionAction } from "./actions";

/** Starts the session when Ivora's automatic start did not. */
export function StartSession({ id }: { id: string }) {
  const [state, action, pending] = useActionState(startSessionAction, EMPTY);
  return (
    <form action={action} className="form">
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="button block" disabled={pending}>
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

/** Stops the session; the final bill is captured when the charger confirms. */
export function StopSession({ id }: { id: string }) {
  const [state, action, pending] = useActionState(stopSessionAction, EMPTY);
  return (
    <form action={action} className="form">
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        className="button secondary block"
        disabled={pending}
      >
        {pending ? "Stopping…" : "Stop charging"}
      </button>
      <DriverError state={state} title="The charger didn't stop" />
    </form>
  );
}
