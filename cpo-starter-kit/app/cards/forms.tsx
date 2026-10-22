"use client";

import Link from "next/link";
import {
  startTransition,
  useActionState,
  useId,
  type FormEvent,
  type ReactNode,
} from "react";
import { NO_STATE, type CardsState, type ImportLine } from "@/lib/cards-state";
import { addCardAction, importCardsAction, updateCardAction } from "./actions";

// The Cards forms. They submit in a transition (as the tariff editor does), so a
// refused form keeps what was typed; a form that worked starts again empty.

/** A form's outcome: an error with every problem, or what was done and any warning. */
function Outcome({ state }: { state: CardsState }) {
  if (state.error)
    return (
      <div className="error" role="alert">
        <p>{state.error}</p>
        {state.problems?.length ? (
          <ul className="explain" aria-label="Other problems">
            {state.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  if (!state.ok) return null;
  return (
    <div className="success" role="status">
      <p>
        {state.ok}{" "}
        {state.cardPath && <Link href={state.cardPath}>Open the card</Link>}
      </p>
      {state.warnings?.map((w) => (
        <p key={w} className="notice">
          {w}
        </p>
      ))}
    </div>
  );
}

const inTransition =
  (action: (data: FormData) => void) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // With the button that sent it: some forms say what to do on the button.
    const submitter = (e.nativeEvent as SubmitEvent).submitter;
    const data = new FormData(e.currentTarget, submitter);
    startTransition(() => action(data));
  };

function HolderFields(p: { kind?: string; name?: string }) {
  const id = useId();
  return (
    <>
      <div className="field">
        <label htmlFor={`${id}-kind`}>Holder</label>
        <select id={`${id}-kind`} name="kind" defaultValue={p.kind ?? "driver"}>
          <option value="driver">Driver</option>
          <option value="vehicle">Vehicle</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-name`}>Driver or vehicle name</label>
        <input
          id={`${id}-name`}
          name="name"
          defaultValue={p.name}
          maxLength={70}
          required
          autoComplete="off"
          aria-describedby={`${id}-name-hint`}
        />
        <span id={`${id}-name-hint`} className="hint">
          Stored in Ivora as the card&apos;s label, for example &quot;Driver:
          Sam Sample&quot; or &quot;Vehicle: Van 12&quot;. A name or a fleet
          number; no other personal data.
        </span>
      </div>
    </>
  );
}

/** Adds one card. The request ID makes a double submit one card. */
export function AddCardForm({ requestId }: { requestId: string }) {
  const [state, action, pending] = useActionState(addCardAction, NO_STATE);
  const id = useId();
  const rid = state.requestId ?? requestId;
  return (
    <form key={rid} onSubmit={inTransition(action)} className="form">
      <input type="hidden" name="requestId" value={rid} />
      <div className="field">
        <label htmlFor={`${id}-value`}>Card value</label>
        <input
          id={`${id}-value`}
          name="value"
          required
          maxLength={36}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          aria-describedby={`${id}-value-hint`}
        />
        <span id={`${id}-value-hint`} className="hint">
          The card&apos;s ID as a charger reads it (its UID or printed number):
          1 to 36 characters without spaces, at most 20 for OCPP 1.6 chargers.
          It is sent to Ivora and never shown again in full.
        </span>
      </div>
      <HolderFields />
      <Outcome state={state} />
      <div>
        <button type="submit" className="button" disabled={pending}>
          {pending ? "Adding…" : "Add card"}
        </button>
      </div>
    </form>
  );
}

const ACTION_LABELS: Record<ImportLine["action"], string> = {
  create: "New card",
  update: "New label",
  unchanged: "Unchanged",
  error: "Refused",
};

function ImportResult({ state }: { state: CardsState }) {
  const o = state.outcome;
  if (!o) return null;
  const { create, update, unchanged, error } = o.counts;
  return (
    <div className="stack">
      <p role={state.ok ? undefined : "status"}>
        {o.dryRun ? "Check: " : "Import: "}
        {create} new, {update} relabelled, {unchanged} unchanged, {error}{" "}
        refused{o.dryRun ? ". Nothing has been sent yet." : "."}
      </p>
      {o.lines.length > 0 && (
        <div className="table-scroll" tabIndex={0}>
          <table
            className="data-table"
            aria-label={o.dryRun ? "Import check" : "Import result"}
          >
            <thead>
              <tr>
                <th scope="col" className="num">
                  Line
                </th>
                <th scope="col">Card</th>
                <th scope="col">Label</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {o.lines.map((l) => (
                <tr key={`${l.line}-${l.action}`}>
                  <td className="num">{l.line}</td>
                  <td className="mono">{l.masked ?? "–"}</td>
                  <td>{l.label ?? "–"}</td>
                  <td>
                    {ACTION_LABELS[l.action]}
                    {l.message ? `: ${l.message}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Imports a CSV file: "Check file" shows what Ivora would do (nothing is stored), then
 * "Import" sends the checked file.
 */
export function ImportCardsForm() {
  const [state, action, pending] = useActionState(importCardsAction, NO_STATE);
  const id = useId();
  const ready = Boolean(state.csv && state.outcome?.dryRun);
  return (
    <div className="stack">
      <form
        key={state.outcome?.dryRun === false ? state.requestId : "check"}
        onSubmit={inTransition(action)}
        className="form"
      >
        <input type="hidden" name="intent" value="check" />
        <div className="field">
          <label htmlFor={`${id}-file`}>CSV file</label>
          <input
            id={`${id}-file`}
            name="file"
            type="file"
            accept=".csv,text/csv,text/plain"
            aria-describedby={`${id}-format`}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-text`}>Or paste the lines</label>
          <textarea
            id={`${id}-text`}
            name="text"
            rows={4}
            spellCheck={false}
            placeholder={"card,holder,name\nDEMO-NEW-0101,driver,Sam Sample"}
            aria-describedby={`${id}-format`}
          />
        </div>
        <p id={`${id}-format`} className="hint muted">
          One card per line: <code>card,holder,name</code>, holder being{" "}
          <code>driver</code> or <code>vehicle</code>. A header line is
          optional; <code>;</code> works as a separator too. Up to 1,000 cards.
          A card already in your list gets the line&apos;s label; an import
          never unblocks a card.
        </p>
        <div>
          <button type="submit" className="button secondary" disabled={pending}>
            {pending ? "Checking…" : "Check file"}
          </button>
        </div>
      </form>
      <ImportResult state={state} />
      <Outcome state={state} />
      {ready && (
        <form onSubmit={inTransition(action)} className="form">
          <input type="hidden" name="intent" value="import" />
          <input type="hidden" name="csv" value={state.csv} />
          <input type="hidden" name="requestId" value={state.requestId} />
          <div>
            <button type="submit" className="button" disabled={pending}>
              {pending
                ? "Importing…"
                : `Import ${state.outcome!.sendable} ${state.outcome!.sendable === 1 ? "card" : "cards"}`}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * A form that changes one card; it names the revision the page was loaded at. Without
 * `intent`, its buttons say what to do (name="intent"), so its outcome stays on the
 * page when the buttons change after the card did.
 */
function CardChange(p: {
  id: number;
  revision: string;
  intent?: string;
  children: ReactNode;
}) {
  const [state, action, pending] = useActionState(updateCardAction, NO_STATE);
  return (
    <form onSubmit={inTransition(action)} className="form" aria-busy={pending}>
      <input type="hidden" name="id" value={p.id} />
      <input type="hidden" name="revision" value={p.revision} />
      {p.intent && <input type="hidden" name="intent" value={p.intent} />}
      {p.children}
      <Outcome state={state} />
    </form>
  );
}

export function HolderForm(p: {
  id: number;
  revision: string;
  kind: string | null;
  name: string;
}) {
  return (
    <CardChange id={p.id} revision={p.revision} intent="label">
      <HolderFields kind={p.kind ?? undefined} name={p.name} />
      <div>
        <button type="submit" className="button">
          Save holder
        </button>
      </div>
    </CardChange>
  );
}

/** Block, unblock or expire now: what a charger does at the card's next tap. */
export function StatusActions(p: {
  id: number;
  revision: string;
  state: "active" | "blocked" | "expired" | "other";
}) {
  return (
    <CardChange id={p.id} revision={p.revision}>
      <div className="actions">
        {p.state !== "active" && (
          <button
            type="submit"
            name="intent"
            value="unblock"
            className="button"
          >
            Make active again
          </button>
        )}
        {p.state !== "blocked" && (
          <button
            type="submit"
            name="intent"
            value="block"
            className="button danger"
          >
            Block card
          </button>
        )}
        {p.state === "active" && (
          <button
            type="submit"
            name="intent"
            value="expire"
            className="button secondary"
          >
            Expire now
          </button>
        )}
      </div>
    </CardChange>
  );
}

export function ExpiryForm(p: {
  id: number;
  revision: string;
  /** YYYY-MM-DD, the last day the card works; null for no expiry. */
  validUntil: string | null;
  today: string;
  zone: string;
}) {
  const id = useId();
  return (
    <CardChange id={p.id} revision={p.revision}>
      <div className="field">
        <label htmlFor={`${id}-date`}>Valid until</label>
        <input
          id={`${id}-date`}
          name="date"
          type="date"
          min={p.today}
          defaultValue={p.validUntil ?? ""}
          aria-describedby={`${id}-date-hint`}
        />
        <span id={`${id}-date-hint`} className="hint">
          The card works through this whole day ({p.zone}); Ivora refuses it
          after.
        </span>
      </div>
      <div className="actions">
        <button
          type="submit"
          name="intent"
          value="expiry"
          className="button secondary"
        >
          Set expiry date
        </button>
        {p.validUntil && (
          <button
            type="submit"
            name="intent"
            value="clear-expiry"
            className="button secondary"
          >
            Remove expiry date
          </button>
        )}
      </div>
    </CardChange>
  );
}
