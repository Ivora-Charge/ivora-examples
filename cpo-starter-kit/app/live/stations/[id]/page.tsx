import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { atLeast } from "@/lib/roles";
import { requireRole } from "@/lib/server/auth";
import { config } from "@/lib/server/env";
import {
  getLive,
  loadStation,
  STARTABLE,
  type SessionView,
} from "@/lib/server/live";
import { formatKwh } from "@/lib/units";
import { CommandsCard } from "../../commands";
import { CommandForm, RecheckForm, ResendForm } from "../../forms";
import { Refresher } from "../../refresher";
import { commandTitle, ConnectorPill, StatePill, when } from "../../status";

export const metadata = { title: "Live charger" };

/** How a session is named in a confirmation: the driver's session, unmistakably. */
const sessionLabel = (s: SessionView) =>
  `${s.staff ? "staff " : ""}session ${s.id}${s.connectorNumber ? ` on connector ${s.connectorNumber}` : ""} (since ${when(s.startedAt)}, ${formatKwh(s.energyKwh)}${s.idToken ? `, token ${s.idToken}` : ""})`;

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const me = await requireRole("viewer");
  const { id } = await params;
  if (!/^\d{1,15}$/.test(id)) notFound();
  const r = await loadStation(getLive(), me, Number(id));
  if (!r.ok)
    return (
      <>
        <p>
          <Link href="/live">← Live</Link>
        </p>
        <h1>Charger</h1>
        <Refresher
          readAt={new Date().toISOString()}
          webhooks={Boolean(config.webhookSecret)}
          pending={false}
          retryAfter={r.retryAfter}
        />
        <p className="error" role="alert">
          {r.error}
        </p>
      </>
    );
  const d = r.detail;
  if (!d) notFound();
  const s = d.station;
  const demo = d.mode === "demo";
  // One command at a time per charger: while one waits, the forms make way for it.
  const canWork = atLeast(me.role, "technician");
  const canSend = canWork && !d.pending;
  const rid = () => randomUUID();
  return (
    <>
      <p>
        <Link href="/live">← Live</Link>
      </p>
      <h1>{s.name}</h1>
      <Refresher
        readAt={d.readAt}
        webhooks={!demo && Boolean(config.webhookSecret)}
        pending={Boolean(d.pending)}
      />
      <section className="card" aria-labelledby="status-heading">
        <h2 id="status-heading">
          Status <StatePill state={s.state} />
          {demo && <span className="badge">Sample</span>}
        </h2>
        <dl className="facts">
          <div>
            <dt>Site</dt>
            <dd>{d.siteName ?? "None"}</dd>
          </div>
          <div>
            <dt>Protocol</dt>
            <dd>{s.protocol ?? "Not reported yet"}</dd>
          </div>
          <div>
            <dt>Last message</dt>
            <dd>{when(s.lastSeen)}</dd>
          </div>
          <div>
            <dt>Open faults</dt>
            <dd>{s.openFaults}</dd>
          </div>
        </dl>
      </section>

      {d.pending && (
        <div className="notice" role="note">
          <p>
            <strong>{commandTitle(d.pending)}</strong> is waiting for an answer
            from the charger. {d.pending.error}
          </p>
          <p>
            No other command is sent to this charger until it is answered.
            Checking again only reads its status; it never sends anything.
          </p>
          {canWork && <RecheckForm id={d.pending.id} />}
          {canWork && d.pending.resendUntil && (
            <ResendForm id={d.pending.id} until={d.pending.resendUntil} />
          )}
        </div>
      )}

      <section className="card" aria-labelledby="connectors-heading">
        <h2 id="connectors-heading">Connectors</h2>
        {s.connectors.length === 0 ? (
          <p className="muted">Ivora reports no connectors yet.</p>
        ) : (
          <ul className="rows" aria-label="Connectors">
            {s.connectors.map((c) => (
              <li key={c.id} className="connector-row">
                <span className="name">Connector {c.number}</span>
                <span className="muted">
                  {[
                    c.maxPowerKw ? `${c.maxPowerKw} kW` : null,
                    c.session
                      ? `session ${c.session.id}, ${formatKwh(c.session.energyKwh)}`
                      : null,
                    c.openFaults
                      ? `${c.openFaults} open ${c.openFaults === 1 ? "fault" : "faults"}`
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
                        s.online &&
                        STARTABLE.has(c.status) &&
                        !c.session
                      }
                      stationId={s.id}
                      action="start"
                      connectorId={c.id}
                      requestId={rid()}
                      label="Remote start…"
                      sendLabel={`Start connector ${c.number}`}
                      confirmText={`I understand this switches on connector ${c.number} with our staff token: a vehicle plugged in there starts charging.`}
                    >
                      <p className="muted">
                        Starts a staff session on connector {c.number} with your
                        operator&apos;s staff token. Ivora records it as a staff
                        session, so it shows in sessions and reports; no driver
                        payment is taken. Only a free (Available) connector: a
                        driver who has plugged in starts and pays as usual. With
                        no vehicle plugged in, the charger waits for one for a
                        short time.
                      </p>
                    </CommandForm>
                    <CommandForm
                      available={canSend && s.online}
                      stationId={s.id}
                      action="unlock"
                      connectorId={c.id}
                      requestId={rid()}
                      label="Unlock…"
                      sendLabel={`Unlock connector ${c.number}`}
                      sessions={
                        c.session
                          ? [
                              {
                                id: c.session.id,
                                label: sessionLabel(c.session),
                              },
                            ]
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
        {!s.online && (
          <p className="muted">
            The charger is offline, so it can&apos;t receive commands.
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="sessions-heading">
        <h2 id="sessions-heading">Sessions</h2>
        {d.recent.length === 0 ? (
          <p className="muted">No sessions yet.</p>
        ) : (
          <ul className="rows" aria-label="Sessions">
            {d.recent.map((x) => (
              <li key={x.id}>
                <span className="name">
                  Session {x.id}
                  {x.connectorNumber ? `, connector ${x.connectorNumber}` : ""}
                </span>
                <span className="muted">
                  {when(x.startedAt)}
                  {x.endedAt ? ` to ${when(x.endedAt)}` : ""} ·{" "}
                  {formatKwh(x.energyKwh)}
                  {x.idToken ? ` · token ${x.idToken}` : ""}
                  {x.staff ? " · staff session" : ""}
                </span>
                <span className={x.active ? "pill busy" : "pill ok"}>
                  {x.active ? "Charging" : "Ended"}
                </span>
                {canWork && (
                  <CommandForm
                    available={canSend && x.active}
                    stationId={s.id}
                    action="stop"
                    transactionId={x.id}
                    requestId={rid()}
                    label="Stop…"
                    sendLabel={`Stop session ${x.id}`}
                    sessions={[{ id: x.id, label: sessionLabel(x) }]}
                    confirmText="I understand the driver's charging stops now."
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canWork && (
        <section className="card" aria-labelledby="reset-heading">
          <h2 id="reset-heading">Reset</h2>
          <p className="muted">
            Restarts the charger. A soft reset lets it end sessions cleanly
            first; a hard reset restarts it at once, like a power cycle. Either
            way it drops off for a moment and reconnects.
          </p>
          {!s.online && (
            <p className="notice" role="note">
              The charger is offline, so it can&apos;t receive a reset.
              Power-cycle it on site.
            </p>
          )}
          <CommandForm
            available={canSend && s.online}
            stationId={s.id}
            action="reset"
            requestId={rid()}
            label="Reset…"
            sendLabel="Reset the charger"
            danger
            sessions={s.sessions.map((x) => ({
              id: x.id,
              label: sessionLabel(x),
            }))}
            confirmText={`I understand this restarts ${s.name}.`}
          >
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
        </section>
      )}

      <section className="card" aria-labelledby="faults-heading">
        <h2 id="faults-heading">Faults</h2>
        {d.faults.length === 0 ? (
          <p className="muted">No faults in the last 90 days.</p>
        ) : (
          <ul className="rows" aria-label="Faults">
            {d.faults.map((f) => (
              <li key={f.id}>
                <span className="name">
                  {f.errorCode ?? f.status ?? "Fault"}
                  <span className="muted">
                    {f.connectorNumber
                      ? `, connector ${f.connectorNumber}`
                      : ", whole charger"}
                  </span>
                </span>
                <span className="muted">
                  {when(f.openedAt)}
                  {f.clearedAt ? ` to ${when(f.clearedAt)}` : ""}
                  {f.info ? ` · ${f.info}` : ""}
                </span>
                <span className={f.open ? "pill warn" : "pill ok"}>
                  {f.open ? "Open" : "Cleared"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <CommandsCard
        commands={d.commands}
        canWork={canWork}
        showStation={false}
      />
    </>
  );
}
