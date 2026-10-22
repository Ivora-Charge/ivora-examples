"use client";

import {
  startTransition,
  useActionState,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { EMPTY, type ActionState, type QuotePreview } from "@/lib/action-state";
// Type only (erased from the client bundle).
import type { EditorValues } from "@/lib/server/pricing/service";
import { Result } from "../result";
import {
  discardTariffAction,
  finishTariffAction,
  previewTariffAction,
  saveTariffAction,
  setStationPricingAction,
} from "./actions";

// The tariff editor and the station assignment form. The browser never prices
// anything: the preview shows Ivora's simulated amounts as the server returns them.

const DAYS = [
  ["MONDAY", "Mon"],
  ["TUESDAY", "Tue"],
  ["WEDNESDAY", "Wed"],
  ["THURSDAY", "Thu"],
  ["FRIDAY", "Fri"],
  ["SATURDAY", "Sat"],
  ["SUNDAY", "Sun"],
] as const;
const WEEKDAYS = DAYS.slice(0, 5).map(([d]) => d as string);

export interface SimulationValues {
  date: string;
  start: string;
  end: string;
  energyKwh: string;
  idleMinutes: string;
}

function Problems({ state }: { state: ActionState }) {
  if (!state.problems?.length) return null;
  return (
    <ul className="error explain" aria-label="Other problems">
      {state.problems.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}

/** Ivora's simulated amounts, exactly as returned. */
export function QuoteTable({ quote }: { quote: QuotePreview }) {
  return (
    <section className="quote" aria-labelledby="quote-heading">
      <h3 id="quote-heading">
        Preview{quote.demo && <span className="badge">Demo</span>}
      </h3>
      <p className="quote-sentence">{quote.sentence}</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Quantity</th>
              <th scope="col">Price</th>
              <th scope="col" className="num">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {quote.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.label}</td>
                <td>{l.quantity}</td>
                <td>{l.unitPrice}</td>
                <td className="num">{l.amount}</td>
              </tr>
            ))}
            {quote.adjustments.map((a, i) => (
              <tr key={`a${i}`}>
                <td colSpan={3}>{a.label}</td>
                <td className="num">{a.amount}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {quote.adjustments.length > 0 && (
              <tr>
                <th scope="row" colSpan={3}>
                  Subtotal
                </th>
                <td className="num">{quote.subtotal}</td>
              </tr>
            )}
            <tr>
              <th scope="row" colSpan={3}>
                Total
              </th>
              <td className="num" data-testid="quote-total">
                {quote.total}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {quote.warnings.map((w) => (
        <p key={w} className="notice" role="note">
          {w}
        </p>
      ))}
      <p>
        <strong>Drivers read:</strong> {quote.driverText}
      </p>
      {quote.notes.map((n) => (
        <p key={n} className="muted">
          {n}
        </p>
      ))}
    </section>
  );
}

function Period(p: {
  index: number;
  value: EditorValues["periods"][number];
  currency: string;
  onRemove: () => void;
}) {
  const id = useId();
  const name = (f: string) => `periods.${p.index}.${f}`;
  return (
    <fieldset className="period">
      <legend>Period {p.index + 1}</legend>
      <div className="period-times">
        <div className="field">
          <label htmlFor={`${id}-start`}>From</label>
          <input
            id={`${id}-start`}
            name={name("start")}
            type="time"
            defaultValue={p.value.start}
            required
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-end`}>Until</label>
          <input
            id={`${id}-end`}
            name={name("end")}
            type="time"
            defaultValue={p.value.end}
            required
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-price`}>
            Period {p.index + 1} price per kWh ({p.currency})
          </label>
          <input
            id={`${id}-price`}
            name={name("price")}
            inputMode="decimal"
            defaultValue={p.value.price}
            required
          />
        </div>
      </div>
      <div
        className="day-choice"
        role="group"
        aria-label={`Period ${p.index + 1} days`}
      >
        {DAYS.map(([day, short]) => (
          <label key={day}>
            <input
              type="checkbox"
              name={name("days")}
              value={day}
              defaultChecked={p.value.days.includes(day)}
            />
            {short}
          </label>
        ))}
      </div>
      <p className="hint muted">
        An end before the start runs past midnight (for example 22:00 until
        06:00). The days are the local day at each moment: an overnight period
        on Saturday covers Saturday 00:00 to 06:00 and 22:00 to midnight.
      </p>
      <div>
        <button type="button" className="button secondary" onClick={p.onRemove}>
          Remove period {p.index + 1}
        </button>
      </div>
    </fieldset>
  );
}

/**
 * Create or edit a tariff. "Preview price" asks Ivora's simulation for the session
 * below; "Save" creates the tariff, or a new version of it. The form is sent from a
 * transition rather than as a form action, so what staff typed stays in the fields
 * after a preview.
 */
export function TariffEditor(p: {
  tariffId: string | null;
  /** The tariff's revision when the page was loaded; a save from a stale page is refused. */
  revision?: number;
  initial: EditorValues;
  currency: string;
  timeZones: readonly string[];
  simulation: SimulationValues;
  /** Saving is refused while an earlier version is unconfirmed. */
  locked?: boolean;
}) {
  const [previewState, preview, previewing] = useActionState(
    previewTariffAction,
    EMPTY,
  );
  const [saveState, save, saving] = useActionState(saveTariffAction, EMPTY);
  const [kind, setKind] = useState(p.initial.kind);
  const [periods, setPeriods] = useState(() =>
    p.initial.periods.map((v, i) => ({ key: i, v })),
  );
  const nextKey = useRef(p.initial.periods.length);
  const [last, setLast] = useState<"preview" | "save" | null>(null);
  const id = useId();
  const f = (n: string) => `${id}-${n}`;
  const busy = previewing || saving;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent)
      .submitter as HTMLButtonElement | null;
    const intent = submitter?.value === "save" ? "save" : "preview";
    const data = new FormData(e.currentTarget);
    setLast(intent);
    startTransition(() => (intent === "save" ? save(data) : preview(data)));
  };

  return (
    <form className="form tariff-form" onSubmit={submit} noValidate={false}>
      {p.tariffId && (
        <>
          <input type="hidden" name="tariffId" value={p.tariffId} />
          <input type="hidden" name="revision" value={p.revision ?? ""} />
        </>
      )}
      <div className="field">
        <label htmlFor={f("name")}>Tariff name</label>
        <input
          id={f("name")}
          name="name"
          defaultValue={p.initial.name}
          maxLength={60}
          required
          aria-describedby={f("name-hint")}
        />
        <span id={f("name-hint")} className="hint">
          For your team, for example &quot;Standard&quot; or &quot;Staff&quot;.
        </span>
      </div>
      <fieldset className="choice">
        <legend>Price</legend>
        <label>
          <input
            type="radio"
            name="kind"
            value="paid"
            checked={kind === "paid"}
            onChange={() => setKind("paid")}
          />
          Paid: drivers pay per kWh
        </label>
        <label>
          <input
            type="radio"
            name="kind"
            value="free"
            checked={kind === "free"}
            onChange={() => setKind("free")}
          />
          Free: zero price, no card hold
        </label>
      </fieldset>
      <div className="field">
        <label htmlFor={f("tz")}>Time zone</label>
        <select
          id={f("tz")}
          name="timeZone"
          defaultValue={p.initial.timeZone}
          aria-describedby={f("tz-hint")}
        >
          {p.timeZones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
        <span id={f("tz-hint")} className="hint">
          The time-of-use periods are local times in this zone. Prices are in{" "}
          {p.currency}.
        </span>
      </div>
      {kind === "paid" && (
        <>
          <div className="field">
            <label htmlFor={f("energy")}>Price per kWh ({p.currency})</label>
            <input
              id={f("energy")}
              name="energy"
              inputMode="decimal"
              defaultValue={p.initial.energy}
              placeholder="0.35"
              required
              aria-describedby={f("energy-hint")}
            />
            <span id={f("energy-hint")} className="hint">
              Outside the time-of-use periods below. Excluding tax.
            </span>
          </div>
          <div className="field">
            <label htmlFor={f("fee")}>
              Session fee ({p.currency}, optional)
            </label>
            <input
              id={f("fee")}
              name="sessionFee"
              inputMode="decimal"
              defaultValue={p.initial.sessionFee}
              placeholder="0.00"
            />
          </div>
          <div className="field">
            <label htmlFor={f("idle")}>
              Idle fee per minute ({p.currency}, optional)
            </label>
            <input
              id={f("idle")}
              name="idleFee"
              inputMode="decimal"
              defaultValue={p.initial.idleFee}
              placeholder="0.00"
              aria-describedby={f("idle-hint")}
            />
            <span id={f("idle-hint")} className="hint">
              Charged per started minute a car is plugged in but not charging:
              after charging ends, and while charging is paused.
            </span>
          </div>
          <div className="field">
            <label htmlFor={f("grace")}>Idle grace period (minutes)</label>
            <input
              id={f("grace")}
              name="idleGrace"
              inputMode="numeric"
              defaultValue={p.initial.idleGrace}
              aria-describedby={f("grace-hint")}
            />
            <span id={f("grace-hint")} className="hint">
              Free idle minutes per session, applied by Ivora. The kit checks
              Ivora applies them before saving; if your account can&apos;t yet,
              set 0.
            </span>
          </div>
          <fieldset className="periods">
            <legend>Time-of-use periods</legend>
            <p className="hint muted">
              A different price per kWh on some days and hours, for example peak
              hours. Periods may not overlap.
            </p>
            {periods.map((x, i) => (
              <Period
                key={x.key}
                index={i}
                value={x.v}
                currency={p.currency}
                onRemove={() =>
                  setPeriods((all) => all.filter((y) => y.key !== x.key))
                }
              />
            ))}
            {periods.length < 4 && (
              <div>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() =>
                    setPeriods((all) => [
                      ...all,
                      {
                        key: nextKey.current++,
                        v: {
                          start: "16:00",
                          end: "21:00",
                          price: "",
                          days: WEEKDAYS,
                        },
                      },
                    ])
                  }
                >
                  Add a time-of-use period
                </button>
              </div>
            )}
          </fieldset>
        </>
      )}
      <div className="field">
        <label htmlFor={f("text")}>What drivers read (optional)</label>
        <textarea
          id={f("text")}
          name="driverText"
          defaultValue={p.initial.driverText}
          maxLength={512}
          rows={3}
          aria-describedby={f("text-hint")}
        />
        <span id={f("text-hint")} className="hint">
          Leave empty to use the kit&apos;s description of the prices (the
          preview shows it). If you write your own, update it whenever the
          prices change.
        </span>
      </div>
      {p.tariffId && p.initial.driverText && (
        <div className="confirm">
          <input id={f("text-ok")} type="checkbox" name="driverTextConfirmed" />
          <label htmlFor={f("text-ok")}>
            My text for drivers matches these prices
          </label>
        </div>
      )}
      <fieldset className="simulate">
        <legend>Preview a session</legend>
        <div className="period-times">
          <div className="field">
            <label htmlFor={f("sim-date")}>Date</label>
            <input
              id={f("sim-date")}
              name="sim.date"
              type="date"
              defaultValue={p.simulation.date}
            />
          </div>
          <div className="field">
            <label htmlFor={f("sim-start")}>Charging from</label>
            <input
              id={f("sim-start")}
              name="sim.start"
              type="time"
              defaultValue={p.simulation.start}
            />
          </div>
          <div className="field">
            <label htmlFor={f("sim-end")}>Until</label>
            <input
              id={f("sim-end")}
              name="sim.end"
              type="time"
              defaultValue={p.simulation.end}
            />
          </div>
          <div className="field">
            <label htmlFor={f("sim-kwh")}>Energy (kWh)</label>
            <input
              id={f("sim-kwh")}
              name="sim.energyKwh"
              inputMode="decimal"
              defaultValue={p.simulation.energyKwh}
            />
          </div>
          <div className="field">
            <label htmlFor={f("sim-idle")}>Then idle (minutes)</label>
            <input
              id={f("sim-idle")}
              name="sim.idleMinutes"
              inputMode="numeric"
              defaultValue={p.simulation.idleMinutes}
            />
          </div>
        </div>
      </fieldset>
      <div className="actions">
        <button
          type="submit"
          name="intent"
          value="preview"
          className="button secondary"
          disabled={busy}
        >
          {previewing ? "Asking Ivora…" : "Preview price"}
        </button>
        <button
          type="submit"
          name="intent"
          value="save"
          className="button"
          disabled={busy || p.locked}
        >
          {saving
            ? "Saving…"
            : p.tariffId
              ? "Save as a new version"
              : "Create tariff"}
        </button>
      </div>
      <div aria-live="polite">
        {last === "save" && (
          <>
            <Result state={saveState} />
            <Problems state={saveState} />
          </>
        )}
        {last === "preview" && (
          <>
            <Result state={{ ...previewState, quote: undefined }} />
            <Problems state={previewState} />
            {previewState.quote && <QuoteTable quote={previewState.quote} />}
          </>
        )}
      </div>
    </form>
  );
}

/**
 * Repeats the unconfirmed steps of the last save (the version is looked up in Ivora
 * first), and, while a version is unconfirmed, offers to discard it.
 */
export function FinishTariff({
  tariffId,
  canDiscard,
}: {
  tariffId: string;
  canDiscard: boolean;
}) {
  const [state, action, pending] = useActionState(finishTariffAction, EMPTY);
  const [discardState, discard, discarding] = useActionState(
    discardTariffAction,
    EMPTY,
  );
  return (
    <>
      <form action={action} className="form">
        <input type="hidden" name="tariffId" value={tariffId} />
        <Result state={state} />
        <Problems state={state} />
        <div>
          <button
            type="submit"
            className="button"
            disabled={pending || discarding}
          >
            {pending ? "Finishing…" : "Finish saving"}
          </button>
        </div>
      </form>
      {canDiscard && (
        <form action={discard} className="form">
          <input type="hidden" name="tariffId" value={tariffId} />
          <Result state={discardState} />
          <div>
            <button
              type="submit"
              className="button secondary"
              disabled={pending || discarding}
            >
              {discarding ? "Discarding…" : "Discard this draft"}
            </button>
          </div>
        </form>
      )}
    </>
  );
}

export interface TariffOption {
  id: string;
  name: string;
}

/** One charger: its tariff, each connector's tariff and private access. */
export function StationPricingForm(p: {
  stationId: number;
  stationName: string;
  /** The station's revision when the page was loaded; a stale save is refused. */
  revision: number;
  tariffId: string | null;
  private: boolean;
  connectors: { id: number; number: number; override: string | null }[];
  tariffs: TariffOption[];
}) {
  const [state, action, pending] = useActionState(
    setStationPricingAction,
    EMPTY,
  );
  const id = useId();
  return (
    <form action={action} className="form">
      <input type="hidden" name="stationId" value={p.stationId} />
      <input type="hidden" name="revision" value={p.revision} />
      <div className="field">
        <label htmlFor={`${id}-tariff`}>Tariff for {p.stationName}</label>
        <select
          id={`${id}-tariff`}
          name="tariffId"
          defaultValue={p.tariffId ?? ""}
        >
          <option value="">No tariff (not for sale)</option>
          {p.tariffs.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      {p.connectors.length > 1 &&
        p.connectors.map((c) => (
          <div className="field" key={c.id}>
            <label htmlFor={`${id}-c${c.id}`}>Connector {c.number}</label>
            <select
              id={`${id}-c${c.id}`}
              name={`connector.${c.id}`}
              defaultValue={c.override ?? "station"}
            >
              <option value="station">Same as the charger</option>
              {p.tariffs.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        ))}
      <div className="confirm">
        <input
          id={`${id}-private`}
          type="checkbox"
          name="private"
          defaultChecked={p.private}
        />
        <label htmlFor={`${id}-private`}>
          Private charger: no public QR checkout, staff and RFID only
        </label>
      </div>
      <Result state={state} />
      <div>
        <button type="submit" className="button" disabled={pending}>
          {pending ? "Saving…" : `Save prices for ${p.stationName}`}
        </button>
      </div>
    </form>
  );
}
