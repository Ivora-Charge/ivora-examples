import Link from "next/link";
import { notFound } from "next/navigation";
import { CrumbName } from "@/app/ui/shell-breadcrumbs";
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
import { Check, StatusPill, When } from "../status";
import { companyZone } from "../zone";
import { ConnectionCard, OverviewPanel } from "./overview";
import { EmptyState } from "@/app/ui/empty-state";
import { PageHeader } from "@/app/ui/page-header";
import { SummaryStrip } from "@/app/ui/summary-strip";
import { Tabs, type TabSpec } from "@/app/ui/tabs";
import {
  ago,
  chargerZone,
  freeConnectorCount,
  zonedTime,
} from "@/lib/charger-table";

export const metadata = { title: "Charger" };

const TABS = ["overview", "configuration", "stickers", "test"] as const;

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const me = await requireRole("viewer");
  const { key } = await params;
  const { tab } = await searchParams;
  const [r, company] = await Promise.all([
    loadCharger(getChargers(), me, key),
    companyZone(me.operatorId),
  ]);
  if (!r.ok)
    return (
      <>
        <PageHeader title="Charger" />
        <div className="card">
          <EmptyState
            tone="error"
            title="This charger did not load"
            action={
              <>
                <Link className="button" href={`/chargers/${key}`}>
                  Try again
                </Link>
                <Link href="/chargers">All chargers</Link>
              </>
            }
          >
            {r.error} Nothing was changed.
          </EmptyState>
        </div>
      </>
    );
  const c = r.charger;
  if (!c) notFound();
  const canWork = atLeast(me.role, "technician");
  const canRemove = atLeast(me.role, "manager") || (canWork && c.pending);
  const registered = !c.pending && !c.missing;
  const free = freeConnectorCount(c);
  const initial = TABS.find((t) => t === tab);
  const zone = chargerZone(
    r.sites.find((s) => s.id === c.locationId)?.time_zone,
    company,
  );
  const seen = zonedTime(c.lastSeen, zone);
  const tabs: TabSpec[] = [
    {
      id: "overview",
      label: "Overview",
      panel: <OverviewPanel c={c} zone={zone} registered={registered} />,
    },
    ...(registered
      ? [
          {
            id: "configuration",
            label: "Configuration",
            panel: (
              <>
                <ConnectionCard c={c} />
                <ConfigurationPanel c={c} sites={r.sites} canWork={canWork} />
              </>
            ),
          },
          {
            id: "stickers",
            label: "QR stickers",
            panel: <StickersCard c={c} canWork={canWork} />,
          },
          {
            id: "test",
            label: "Test",
            panel: (
              <>
                <ConnectionTestCard c={c} canWork={canWork} zone={zone} />
                <RemoteTestCard c={c} canWork={canWork} />
              </>
            ),
          },
        ]
      : []),
  ];
  return (
    <>
      <PageHeader
        title={c.label}
        description={[c.label !== c.name ? c.name : null, c.siteName]
          .filter(Boolean)
          .join(" · ")}
      />
      <CrumbName path={`/chargers/${c.key}`} label={c.label} />
      {me.demo && <p className="muted">Sample charger: demo data only.</p>}
      {c.pending && (
        <div className="notice" role="note">
          <p>
            This charger is in the kit but not registered in Ivora yet: the last
            try did not finish. Finishing repeats the same steps with the same
            idempotency keys, so nothing is created twice.
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
      <SummaryStrip
        label="Charger at a glance"
        items={[
          { label: "Status", value: <StatusPill c={c} /> },
          {
            label: "Connectors",
            value: c.connectors.length ? free : "None",
            unit: c.connectors.length ? `of ${c.connectors.length} free` : "",
          },
          {
            label: "Last message",
            value: (
              <span className="strip-text">
                {seen ? (
                  <time dateTime={c.lastSeen!}>{seen.local}</time>
                ) : (
                  "Never"
                )}
              </span>
            ),
            unit: seen
              ? `${seen.zone === "UTC" ? "UTC" : seen.zone} · ${ago(c.lastSeen)}`
              : "",
          },
        ]}
      />
      <Tabs label="Charger sections" tabs={tabs} initial={initial} />
      {canRemove && (
        <section className="card danger-zone" aria-labelledby="remove-heading">
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

function ConfigurationPanel({
  c,
  sites,
  canWork,
}: {
  c: ChargerView;
  sites: { id: number; name: string }[];
  canWork: boolean;
}) {
  if (!canWork)
    return (
      <p className="muted">
        Technicians, managers and owners can change a charger&apos;s settings.
      </p>
    );
  return (
    <>
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
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <span id="edit-site-hint" className="hint">
              Moving the charger changes its site in Ivora. The connection name
              can&apos;t change once the charger has connected; to rename it,
              add it again under a new name.
            </span>
          </div>
        </ChargerAction>
      </section>
      <section className="card" aria-labelledby="password-heading">
        <h2 id="password-heading">Charger password</h2>
        <p className="muted">
          A new random password, shown once. An offline charger gets it when it
          next connects; a connected OCPP 2.0.1 charger receives it now. A
          connected OCPP 1.6 charger can&apos;t be changed remotely: Ivora
          refuses, so disconnect it first or change it in the charger&apos;s own
          settings. Ivora limits how often a password can change.
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
    </>
  );
}

function ConnectionTestCard({
  c,
  canWork,
  zone,
}: {
  c: ChargerView;
  canWork: boolean;
  zone: string;
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
        Checks the charger is connected, has booted and sent a message in the
        last {HEARTBEAT_FRESH_SECONDS / 60} minutes. Nothing is sent to it.
      </p>
      {t && (
        <>
          <ul className="rows checks" aria-label="Connection test results">
            <Check ok={t.online} label="Connected to Ivora" />
            <Check ok={t.booted} label="Booted" />
            <Check ok={t.heartbeat} label="Recent heartbeat" />
          </ul>
          <p className="muted">
            Last run <When iso={t.at} zone={zone} />
          </p>
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
        Starts and stops a short free session on one connector, to prove the
        charger takes remote commands.
      </p>
      <details className="how">
        <summary>How this test works</summary>
        <p className="muted">
          Starts a short session on one connector with an operator command (no
          payment) and the staff token, so it shows as a staff/test session in
          Live and Ivora&apos;s reports, then stops it. Energy is 0 kWh without
          a vehicle; the test passes when the charger accepts the start and stop
          and reports the session. It runs only on an Available connector, and
          it only ever stops its own session.
        </p>
      </details>
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
