import { randomUUID } from "node:crypto";
import Link from "next/link";
import {
  STARTABLE,
  type LiveSnapshot,
  type StationView,
} from "@/lib/server/live";
import { formatKwh } from "@/lib/units";
import { CommandForm, RecheckForm, ResendForm } from "./forms";
import {
  commandTitle,
  ConnectorPill,
  sessionLabel,
  StatePill,
  when,
} from "./status";

/**
 * The selected charger on the Live screen: its status, open faults and the remote
 * actions (reset, unlock, start). Each action is the same confirmation form, and the
 * same server action, as on the charger's own page; stopping a session stays there.
 */
export function ChargerPanel({
  live,
  station,
  siteName,
  canWork,
}: {
  live: LiveSnapshot;
  station: StationView;
  siteName: string;
  canWork: boolean;
}) {
  const faults = live.faults.filter((f) => f.stationId === station.id);
  // One command at a time per charger: while one waits, the forms make way for it.
  const pending = live.commands.find(
    (c) => c.stationId === station.id && c.phase === "pending",
  );
  const canSend = canWork && !pending;
  const rid = () => randomUUID();
  return (
    <section
      className="card charger-panel"
      id="charger-panel"
      aria-labelledby="panel-heading"
    >
      <div className="chead">
        <h2 id="panel-heading">{station.name}</h2>
        <StatePill state={station.state} />
      </div>
      <p className="muted sm">{siteName}</p>
      <dl className="facts">
        <div>
          <dt>Last message</dt>
          <dd>{when(station.lastSeen)}</dd>
        </div>
        <div>
          <dt>Open faults</dt>
          <dd>
            {faults.length === 0
              ? "None"
              : faults
                  .map(
                    (f) =>
                      `${f.errorCode ?? f.status ?? "Fault"}${f.connectorNumber ? `, connector ${f.connectorNumber}` : ""}`,
                  )
                  .join("; ")}
          </dd>
        </div>
      </dl>

      {pending && (
        <div className="notice" role="note">
          <p>
            <strong>{commandTitle(pending)}</strong> is waiting for an answer
            from the charger. No other command is sent to this charger until it
            is answered.
          </p>
          {canWork && <RecheckForm id={pending.id} />}
          {canWork && pending.resendUntil && (
            <ResendForm id={pending.id} until={pending.resendUntil} />
          )}
        </div>
      )}

      <h3>Connectors</h3>
      {station.connectors.length === 0 ? (
        <p className="muted">Ivora reports no connectors yet.</p>
      ) : (
        <ul className="rows" aria-label={`Connectors on ${station.name}`}>
          {station.connectors.map((c) => (
            <li key={c.id} className="connector-row">
              <span className="name">Connector {c.number}</span>
              <span className="muted">
                {[
                  c.maxPowerKw ? `${c.maxPowerKw} kW` : null,
                  c.session
                    ? `session ${c.session.id}, ${formatKwh(c.session.energyKwh)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <ConnectorPill status={c.status} />
              {canWork && (
                <span className="actions">
                  <CommandForm
                    available={
                      canSend &&
                      station.online &&
                      STARTABLE.has(c.status) &&
                      !c.session
                    }
                    stationId={station.id}
                    action="start"
                    connectorId={c.id}
                    requestId={rid()}
                    label="Start session…"
                    sendLabel={`Start connector ${c.number}`}
                    confirmText={`I understand this switches on connector ${c.number} with our staff token: a vehicle plugged in there starts charging.`}
                  >
                    <p className="muted">
                      Starts a staff/test session on connector {c.number} with
                      your operator&apos;s staff token. Ivora records it as a
                      staff session, so it shows in sessions and reports; no
                      driver payment is taken. Only a free (Available)
                      connector: a driver who has plugged in starts and pays as
                      usual. With no vehicle plugged in, the charger waits for
                      one for a short time.
                    </p>
                  </CommandForm>
                  <CommandForm
                    available={canSend && station.online}
                    stationId={station.id}
                    action="unlock"
                    connectorId={c.id}
                    requestId={rid()}
                    label="Unlock connector…"
                    sendLabel={`Unlock connector ${c.number}`}
                    sessions={
                      c.session
                        ? [{ id: c.session.id, label: sessionLabel(c.session) }]
                        : []
                    }
                    confirmText={`I understand this unlocks connector ${c.number}.`}
                  >
                    <p className="muted">
                      Releases a cable stuck in the connector.
                      {c.session &&
                        " A session running on it ends: the charger stops charging first."}
                    </p>
                  </CommandForm>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {canWork ? (
        <>
          <h3>Remote actions</h3>
          {!station.online && (
            <p className="notice" role="note">
              The charger is offline, so it can&apos;t receive commands.
              Power-cycle it on site.
            </p>
          )}
          <CommandForm
            available={canSend && station.online}
            stationId={station.id}
            action="reset"
            requestId={rid()}
            label="Reset…"
            sendLabel="Reset the charger"
            danger
            sessions={station.sessions.map((x) => ({
              id: x.id,
              label: sessionLabel(x),
            }))}
            confirmText={`I understand this restarts ${station.name}.`}
          >
            <p className="muted">
              Reset restarts the charger and ends any session in progress. A
              soft reset lets it end sessions cleanly first; a hard reset
              restarts it at once, like a power cycle.
            </p>
            <fieldset className="choice">
              <legend>Reset type</legend>
              <label>
                <input type="radio" name="mode" value="soft" defaultChecked />{" "}
                Soft: ends sessions cleanly, then restarts
              </label>
              <label>
                <input type="radio" name="mode" value="hard" /> Hard: restarts
                at once
              </label>
            </fieldset>
          </CommandForm>
          <p className="muted sm">
            Each action asks you to confirm first. To stop a driver&apos;s
            session, open the charger.
          </p>
        </>
      ) : (
        <p className="muted">
          Viewers see the live state. Technicians, managers and owners can
          start, stop, reset and unlock chargers.
        </p>
      )}
      <p>
        <Link href={`/live/stations/${station.id}`}>
          Open {station.name}: sessions, fault history and stop →
        </Link>
      </p>
    </section>
  );
}
