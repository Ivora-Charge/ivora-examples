import Link from "next/link";
import { notFound } from "next/navigation";
import { atLeast } from "@/lib/roles";
import { requireRole } from "@/lib/server/auth";
import {
  getChargers,
  HEARTBEAT_FRESH_SECONDS,
  loadCharger,
  testEnergyKwh,
  type ChargerView,
} from "@/lib/server/chargers";
import { qrBase } from "@/lib/server/qr";
import { formatKwh } from "@/lib/units";
import {
  checkTestAction,
  connectionTestAction,
  editChargerAction,
  finishAddingAction,
  prepareStickersAction,
  removeChargerAction,
  resetPasswordAction,
  startTestAction,
  stopTestAction,
} from "../actions";
import { ChargerAction, Confirm } from "../forms";
import { Check, StatusPill } from "../status";

export const metadata = { title: "Charger" };

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toISOString().replace("T", " ").slice(0, 19) + " UTC"
    : "Never";

export default async function Page({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const me = await requireRole("viewer");
  const { key } = await params;
  const r = await loadCharger(getChargers(), me, key);
  if (!r.ok)
    return (
      <>
        <h1>Charger</h1>
        <p className="error" role="alert">
          {r.error}
        </p>
      </>
    );
  const c = r.charger;
  if (!c) notFound();
  const canWork = atLeast(me.role, "technician");
  const canRemove = atLeast(me.role, "manager") || (canWork && c.pending);
  const registered = !c.pending && !c.missing;
  return (
    <>
      <p>
        <Link href="/chargers">← All chargers</Link>
      </p>
      <h1>{c.label}</h1>
      <section className="card" aria-labelledby="about-heading">
        <h2 id="about-heading">
          Charger <StatusPill c={c} />
          {me.demo && <span className="badge">Sample</span>}
        </h2>
        {c.pending && (
          <div className="notice" role="note">
            <p>
              This charger is in the kit but not registered in Ivora yet: the
              last try did not finish. Finishing repeats the same steps with the
              same idempotency keys, so nothing is created twice.
            </p>
            {canWork && (
              <ChargerAction
                action={finishAddingAction}
                chargerKey={c.key}
                label="Finish adding"
                pendingLabel="Registering…"
              />
            )}
          </div>
        )}
        {c.missing && (
          <p className="notice" role="note">
            Ivora no longer has this charger&apos;s station (it was deleted
            outside the kit). Remove it from the kit below.
          </p>
        )}
        <dl className="facts">
          <div>
            <dt>Connection name</dt>
            <dd>
              <code>{c.name}</code>
            </dd>
          </div>
          <div>
            <dt>Site</dt>
            <dd>{c.siteName ?? "None"}</dd>
          </div>
          {c.connectionUrl && (
            <div>
              <dt>OCPP connection URL</dt>
              <dd>
                <code>{c.connectionUrl}</code>
              </dd>
            </div>
          )}
          <div>
            <dt>Password</dt>
            <dd>
              {c.passwordSet
                ? "Set by the kit (not shown again)"
                : "Not set by the kit"}
            </dd>
          </div>
          <div>
            <dt>Charger</dt>
            <dd>
              {[c.vendor, c.model, c.protocol].filter(Boolean).join(" · ") ||
                "Not reported yet"}
            </dd>
          </div>
          <div>
            <dt>Last message</dt>
            <dd>{when(c.lastSeen)}</dd>
          </div>
        </dl>
        {c.connectors.length > 0 && (
          <ul className="rows" aria-label="Connectors">
            {c.connectors.map((k) => (
              <li key={k.id}>
                <span className="name">Connector {k.number}</span>
                <span className="muted">
                  {[k.status, k.maxPowerKw ? `${k.maxPowerKw} kW` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {registered && <ConnectionTestCard c={c} canWork={canWork} />}
      {registered && <RemoteTestCard c={c} canWork={canWork} />}
      {registered && <StickersCard c={c} canWork={canWork} />}

      {canWork && registered && (
        <section className="card" aria-labelledby="edit-heading">
          <h2 id="edit-heading">Edit</h2>
          <ChargerAction
            action={editChargerAction}
            chargerKey={c.key}
            label="Save"
            pendingLabel="Saving…"
          >
            <div className="field">
              <label htmlFor="edit-label">Display name</label>
              <input
                id="edit-label"
                name="label"
                defaultValue={c.label === c.name ? "" : c.label}
                maxLength={80}
                placeholder={c.name}
              />
            </div>
            <div className="field">
              <label htmlFor="edit-site">Site</label>
              <select
                id="edit-site"
                name="locationId"
                defaultValue={c.locationId ?? undefined}
                aria-describedby="edit-site-hint"
              >
                {r.sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <span id="edit-site-hint" className="hint">
                Moving the charger changes its site in Ivora. The connection
                name can&apos;t change once the charger has connected; to rename
                it, add it again under a new name.
              </span>
            </div>
          </ChargerAction>
        </section>
      )}

      {canWork && registered && (
        <section className="card" aria-labelledby="password-heading">
          <h2 id="password-heading">Charger password</h2>
          <p className="muted">
            A new random password, shown once. An offline charger gets it when
            it next connects; a connected OCPP 2.0.1 charger receives it now. A
            connected OCPP 1.6 charger can&apos;t be changed remotely: Ivora
            refuses, so disconnect it first or change it in the charger&apos;s
            own settings. Ivora limits how often a password can change.
          </p>
          <ChargerAction
            action={resetPasswordAction}
            chargerKey={c.key}
            label="Set a new password"
            pendingLabel="Setting…"
            variant="secondary"
          >
            <Confirm>
              I understand the charger can&apos;t connect with its old password
              afterwards.
            </Confirm>
          </ChargerAction>
        </section>
      )}

      {canRemove && (
        <section className="card" aria-labelledby="remove-heading">
          <h2 id="remove-heading">Remove</h2>
          <ul className="explain">
            <li>
              If the charger <strong>never charged</strong>, Ivora deletes the
              station and its connectors, and disconnects it if it is connected.
            </li>
            <li>
              If it <strong>has charging history</strong>, Ivora keeps it, so
              its sessions stay in your records; the kit hides it.
            </li>
            <li>
              Either way its QR stickers stop leading to it (they say &quot;not
              in service&quot;), and a running session must be stopped first.
            </li>
          </ul>
          <ChargerAction
            action={removeChargerAction}
            chargerKey={c.key}
            label="Remove charger"
            pendingLabel="Removing…"
            variant="danger"
          >
            <Confirm>I understand, remove {c.label}.</Confirm>
          </ChargerAction>
        </section>
      )}
    </>
  );
}

function ConnectionTestCard({
  c,
  canWork,
}: {
  c: ChargerView;
  canWork: boolean;
}) {
  const t = c.connectionTest;
  return (
    <section className="card" aria-labelledby="conn-heading">
      <h2 id="conn-heading">
        Connection test
        {t && (
          <span className={t.passed ? "pill ok" : "pill off"}>
            {t.passed ? "Passed" : "Failed"}
          </span>
        )}
      </h2>
      <p className="muted">
        Checks the charger is connected, has booted (sent its BootNotification)
        and sent a message in the last {HEARTBEAT_FRESH_SECONDS / 60} minutes.
        Reads only: nothing is sent to the charger.
      </p>
      {t && (
        <>
          <ul className="rows checks" aria-label="Connection test results">
            <Check ok={t.online} label="Connected to Ivora" />
            <Check ok={t.booted} label="Booted" />
            <Check ok={t.heartbeat} label="Recent heartbeat" />
          </ul>
          <p className="muted">Last run {when(t.at)}.</p>
        </>
      )}
      {canWork && (
        <ChargerAction
          action={connectionTestAction}
          chargerKey={c.key}
          label={t ? "Run again" : "Run connection test"}
          pendingLabel="Testing…"
        />
      )}
    </section>
  );
}

const PHASE: Record<string, string> = {
  starting: "Starting",
  charging: "Charging",
  stopping: "Stopping",
  passed: "Passed",
  failed: "Failed",
};

function RemoteTestCard({ c, canWork }: { c: ChargerView; canWork: boolean }) {
  const t = c.remoteTest;
  const running =
    t &&
    (t.phase === "starting" ||
      t.phase === "charging" ||
      t.phase === "stopping");
  return (
    <section className="card" aria-labelledby="remote-heading">
      <h2 id="remote-heading">
        Remote start and stop test
        <span className="muted">Optional</span>
        {t && (
          <span
            className={
              t.phase === "passed"
                ? "pill ok"
                : t.phase === "failed"
                  ? "pill off"
                  : "pill warn"
            }
          >
            {PHASE[t.phase]}
          </span>
        )}
      </h2>
      <p className="muted">
        Starts a short session on one connector with an operator command (no
        payment), then stops it. Energy is 0 kWh without a vehicle; the test
        passes when the charger accepts the start and stop and reports the
        session. It runs only on an Available connector, and it only ever stops
        its own session.
      </p>
      {t && (
        <p>
          Test {t.attempt}, connector {t.connectorNumber}:{" "}
          {PHASE[t.phase].toLowerCase()}, {formatKwh(testEnergyKwh(t))}.
          {t.error && <span className="error-text"> {t.error}</span>}
        </p>
      )}
      {canWork && running && (
        <div className="actions">
          <ChargerAction
            action={checkTestAction}
            chargerKey={c.key}
            label="Check again"
            pendingLabel="Checking…"
            variant="secondary"
          />
          <ChargerAction
            action={stopTestAction}
            chargerKey={c.key}
            label="Stop the test"
            pendingLabel="Stopping…"
          />
        </div>
      )}
      {canWork && !running && (
        <>
          {!c.online && (
            <p className="notice" role="note">
              The charger is offline: connect it and pass the connection test
              first.
            </p>
          )}
          {c.online && (
            <ChargerAction
              action={startTestAction}
              chargerKey={c.key}
              label="Start the test"
              pendingLabel="Starting…"
            >
              <div className="field">
                <label htmlFor="test-connector">Connector</label>
                <select id="test-connector" name="connector">
                  {c.connectors.map((k) => (
                    <option key={k.id} value={k.number}>
                      Connector {k.number}
                      {k.status ? ` (${k.status})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <p className="notice warning-text">
                <strong>This starts the charger.</strong> It switches on power
                to the connector, and a vehicle plugged in there starts
                charging. Make sure the connector is safe to use.
              </p>
              <Confirm>I understand this starts the charger.</Confirm>
            </ChargerAction>
          )}
        </>
      )}
    </section>
  );
}

async function StickersCard({
  c,
  canWork,
}: {
  c: ChargerView;
  canWork: boolean;
}) {
  const base = await qrBase();
  const coded = c.connectors.filter((k) => k.code);
  const complete =
    c.connectors.length > 0 && coded.length === c.connectors.length;
  return (
    <section className="card" aria-labelledby="stickers-heading">
      <h2 id="stickers-heading">QR stickers</h2>
      <p className="muted">
        One sticker per connector. Each has a stable code on your own domain (
        <code>/c/&lt;code&gt;</code>), so you can move hosting or replace the
        charger without reprinting.
      </p>
      {!base.ok && (
        <p className="notice" role="note">
          Printing is off: {base.reason}
        </p>
      )}
      {coded.length > 0 && (
        <ul className="rows" aria-label="Sticker codes">
          {coded.map((k) => (
            <li key={k.id}>
              <span className="name">Connector {k.number}</span>
              <code>{k.code}</code>
            </li>
          ))}
        </ul>
      )}
      {complete && c.recordId ? (
        <p>
          <Link
            className="button secondary"
            href={`/chargers/${c.recordId}/stickers`}
          >
            Show stickers to print
          </Link>
        </p>
      ) : canWork ? (
        <ChargerAction
          action={prepareStickersAction}
          chargerKey={c.key}
          label="Create sticker codes"
          pendingLabel="Creating…"
          variant="secondary"
        />
      ) : (
        <p className="muted">No sticker codes yet.</p>
      )}
    </section>
  );
}
