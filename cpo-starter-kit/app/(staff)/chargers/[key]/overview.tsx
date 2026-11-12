import type { ChargerView } from "@/lib/server/chargers";
import { Chip } from "@/app/ui/status-chip";
import { connectorChip } from "@/lib/status-chips";
import { When } from "../status";

/**
 * The Overview tab: connector tiles and a few short facts. A charger that is not
 * registered has no Configuration tab, so its Connection card shows here instead.
 */
export function OverviewPanel({
  c,
  zone,
  registered,
}: {
  c: ChargerView;
  zone: string;
  registered: boolean;
}) {
  return (
    <>
      <section className="card" aria-labelledby="connectors-heading">
        <h2 id="connectors-heading">Connectors</h2>
        {c.connectors.length ? (
          <ul className="connector-tiles" aria-label="Connectors">
            {c.connectors.map((k) => (
              <li key={k.id} className="connector-tile">
                <span className="name">Connector {k.number}</span>
                {k.status ? (
                  <Chip spec={connectorChip(k.status)} />
                ) : (
                  <span className="muted">No status yet</span>
                )}
                <span className="muted">
                  {k.maxPowerKw
                    ? `Up to ${k.maxPowerKw} kW`
                    : "Power not reported"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">
            Ivora reports no connectors yet. They appear once the charger
            connects.
          </p>
        )}
      </section>
      <section className="card" aria-labelledby="about-heading">
        <h2 id="about-heading">Charger</h2>
        <dl className="facts">
          <div>
            <dt>Site</dt>
            <dd>{c.siteName ?? "None"}</dd>
          </div>
          <div>
            <dt>Make and model</dt>
            <dd>
              {[c.vendor, c.model].filter(Boolean).join(" · ") ||
                "Not reported yet"}
            </dd>
          </div>
          <div>
            <dt>Last message</dt>
            <dd>
              <When iso={c.lastSeen} zone={zone} />
            </dd>
          </div>
        </dl>
      </section>
      {!registered && <ConnectionCard c={c} />}
    </>
  );
}

/** Read-only: how the charger connects. Everyone who can see the charger sees it. */
export function ConnectionCard({ c }: { c: ChargerView }) {
  return (
    <section className="card" aria-labelledby="connection-heading">
      <h2 id="connection-heading">Connection</h2>
      <dl className="facts">
        <div>
          <dt>Connection name</dt>
          <dd>
            <code>{c.name}</code>
          </dd>
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
          <dt>Protocol</dt>
          <dd>{c.protocol ?? "Not reported yet"}</dd>
        </div>
      </dl>
    </section>
  );
}
