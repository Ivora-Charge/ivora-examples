"use client";

import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { EMPTY } from "@/lib/action-state";
import { Result } from "../result";
import {
  recheckCommandAction,
  resendCommandAction,
  sendCommandAction,
} from "./actions";

/** A session the command would end, named in its confirmation. */
export interface SessionToConfirm {
  id: number;
  label: string;
}

const newRequestId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "";

/**
 * One charger command behind a confirmation: the button opens the form, which says
 * what the command does, names every session it would end (each needs its own tick)
 * and needs a final "I understand" tick before it can be sent. Each opening gets a new
 * request ID, and sending the same form twice sends one command.
 */
export function CommandForm(p: {
  stationId: number;
  action: "start" | "stop" | "reset" | "unlock";
  /** The button that opens the confirmation. */
  label: string;
  /** The button that sends it. */
  sendLabel: string;
  /** From the server, so the form also works before scripts run. */
  requestId: string;
  connectorId?: number;
  transactionId?: number;
  sessions?: SessionToConfirm[];
  danger?: boolean;
  confirmText: string;
  /**
   * False once the command no longer applies (the connector is busy, the session
   * ended, the charger is offline): only the last outcome stays. The form stays
   * mounted either way, so that outcome survives the page's refresh.
   */
  available?: boolean;
  children?: ReactNode;
}) {
  const [state, action, pending] = useActionState(sendCommandAction, EMPTY);
  const [requestId, setRequestId] = useState(p.requestId);
  const details = useRef<HTMLDetailsElement>(null);
  const id = useId();
  // A finished send closes the form; opening it again is a new tap.
  useEffect(() => {
    if (state !== EMPTY && details.current) details.current.open = false;
  }, [state]);
  if (p.available === false)
    return state === EMPTY ? null : (
      <div className="command">
        <Result state={state} />
      </div>
    );
  return (
    <div className="command">
      <Result state={state} />
      <details
        ref={details}
        onToggle={(e) => {
          if (e.currentTarget.open) setRequestId(newRequestId() || p.requestId);
        }}
      >
        <summary className={p.danger ? "button danger" : "button secondary"}>
          {p.label}
        </summary>
        <form action={action} className="form confirm-box">
          <input type="hidden" name="requestId" value={requestId} />
          <input type="hidden" name="stationId" value={p.stationId} />
          <input type="hidden" name="action" value={p.action} />
          {p.connectorId !== undefined && (
            <input type="hidden" name="connectorId" value={p.connectorId} />
          )}
          {p.transactionId !== undefined && (
            <input type="hidden" name="transactionId" value={p.transactionId} />
          )}
          {p.children}
          {(p.sessions ?? []).length > 0 && (
            <fieldset className="sessions-to-end">
              <legend>
                <strong>This ends a driver&apos;s session.</strong> Tick each
                one to confirm:
              </legend>
              {p.sessions!.map((s) => (
                <div className="confirm" key={s.id}>
                  <input
                    id={`${id}-s${s.id}`}
                    type="checkbox"
                    name="session"
                    value={s.id}
                    required
                  />
                  <label htmlFor={`${id}-s${s.id}`}>End {s.label}</label>
                </div>
              ))}
            </fieldset>
          )}
          <div className="confirm">
            <input id={`${id}-ok`} type="checkbox" name="confirm" required />
            <label htmlFor={`${id}-ok`}>{p.confirmText}</label>
          </div>
          <div>
            <button
              type="submit"
              className={p.danger ? "button danger" : "button"}
              disabled={pending}
            >
              {pending ? "Sending…" : p.sendLabel}
            </button>
          </div>
        </form>
      </details>
    </div>
  );
}

/** Checks a pending command again: reads its status, never sends anything. */
export function RecheckForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState(recheckCommandAction, EMPTY);
  return (
    <>
      <Result state={state} />
      <form action={action}>
        <input type="hidden" name="id" value={id} />
        <button type="submit" className="button secondary" disabled={pending}>
          {pending ? "Checking…" : "Check again"}
        </button>
      </form>
    </>
  );
}

/**
 * Sends a command Ivora never confirmed again, with the same idempotency key: its own
 * explicit action, offered only within a minute of the first send. The server reads
 * the charger's sessions again first.
 */
export function ResendForm({ id, until }: { id: string; until: string }) {
  const [state, action, pending] = useActionState(resendCommandAction, EMPTY);
  const tick = useId();
  return (
    <>
      <Result state={state} />
      <form action={action} className="resend">
        <input type="hidden" name="id" value={id} />
        <p className="muted">
          Ivora did not confirm it received this command. Until{" "}
          {until.slice(11, 19)} UTC you can send the same command again (same
          idempotency key, so it happens at most once). After that it closes as
          unknown and you start a new one.
        </p>
        <div className="confirm">
          <input id={tick} type="checkbox" name="confirm" required />
          <label htmlFor={tick}>
            I checked the charger; send the same command again
          </label>
        </div>
        <button type="submit" className="button secondary" disabled={pending}>
          {pending ? "Sending…" : "Send again"}
        </button>
      </form>
    </>
  );
}
