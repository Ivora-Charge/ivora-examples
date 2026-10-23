import Link from "next/link";
import { atLeast } from "@/lib/roles";
import { requireRole } from "@/lib/server/auth";
import { describeError, IvoraError } from "@/lib/server/ivora";
import { DEMO_TAKEN_PARTY } from "@/lib/server/ivora/demo-ocpi";
import { MAX_LIST_PAGES } from "@/lib/server/ivora/live";
import {
  getRoaming,
  loadRoaming,
  partyLabel,
  type RoamingView,
} from "@/lib/server/roaming";
import { resetDemoRoamingAction } from "./actions";
import { DemoPartyDecision, RoamingForm } from "./forms";
import { Loading } from "@/app/loading-skeleton";

export const metadata = { title: "Roaming" };

function Heading() {
  return (
    <h1>
      Roaming <span className="badge">Placeholder</span>
    </h1>
  );
}

function Placeholder() {
  return (
    <section
      className="card notice roaming-placeholder"
      aria-labelledby="placeholder-heading"
    >
      <h2 id="placeholder-heading">Roaming placeholder (OCPI)</h2>
      <p>
        This page sets what Ivora publishes about your network to its OCPI
        roaming partners: whether your sites are shared, the operator name they
        show, and your own party ID. It reads and writes only Ivora&apos;s
        publishing settings. Settling roaming payments with partners is not part
        of this kit; it comes later as a separate add-on.
      </p>
    </section>
  );
}

/** Why partners do or do not receive the sites now. */
function publishingReason(v: RoamingView): string {
  const s = v.settings;
  if (s.private)
    return "Ivora keeps this network private, so it is never published.";
  if (!s.publish) return "Publishing is off.";
  if (!s.display_name) return "Publishing needs an operator name.";
  if (!s.versions_url)
    return "Your settings are saved, but this Ivora environment does not serve OCPI yet. They take effect once it does.";
  if (v.demo)
    return "Demo: with these settings in live mode, partners would receive your sites, availability and published prices. Nothing is sent from the demo.";
  return "Partners receive your sites, availability and published prices.";
}

function PartyStatus({ v }: { v: RoamingView }) {
  const s = v.settings;
  const shared = partyLabel(s.party);
  const own = s.own_party;
  if (!own)
    return (
      <p>
        No own party ID requested. Partners see your sites under Ivora&apos;s
        shared party <strong>{shared}</strong>, with your operator name.
      </p>
    );
  const label = partyLabel(own);
  if (own.status === "approved")
    return (
      <p>
        <span className="pill ok">Approved</span> Ivora approved{" "}
        <strong>{label}</strong>.
        {s.published
          ? " Partners see your sites under it."
          : " Partners see your sites under it once you publish."}
      </p>
    );
  if (own.status === "rejected")
    return (
      <>
        <p>
          <span className="pill off">Not approved</span> Ivora could not confirm
          that you hold <strong>{label}</strong>
          {own.rejection_note ? `: ${own.rejection_note}` : "."}
        </p>
        <p className="muted">
          Partners see your sites under Ivora&apos;s shared party{" "}
          <strong>{shared}</strong>, with your operator name. Send Ivora support
          the registry entry or a letter of authorization, and they can still
          approve it.
        </p>
      </>
    );
  return (
    <>
      <p>
        <span className="pill warn">Waiting for Ivora</span> You requested{" "}
        <strong>{label}</strong>. Ivora checks with the registry before using
        it.
      </p>
      <p className="muted">
        Until then partners see your sites under Ivora&apos;s shared party{" "}
        <strong>{shared}</strong>, with your operator name.
      </p>
    </>
  );
}

async function Content() {
  const me = await requireRole("viewer");
  if (!atLeast(me.role, "manager"))
    return (
      <>
        <Heading />
        <section className="card" aria-labelledby="no-access-heading">
          <h2 id="no-access-heading">Owners and managers only</h2>
          <p className="muted">
            Roaming settings decide what partners show of your network. Ask an
            owner or a manager if something here needs to change.
          </p>
        </section>
      </>
    );

  let v: RoamingView;
  try {
    v = await loadRoaming(getRoaming(), me);
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    return (
      <>
        <Heading />
        <Placeholder />
        <section className="card" aria-labelledby="roaming-error-heading">
          <h2 id="roaming-error-heading">Could not read the settings</h2>
          <p className="error" role="alert">
            {describeError(e)}
          </p>
          <p className="muted">
            The API key needs <code>stations:read</code> to read and{" "}
            <code>stations:write</code> to change these settings.
          </p>
        </section>
      </>
    );
  }
  const s = v.settings;

  return (
    <>
      <Heading />
      <p>
        <Link href="/settings">← Settings</Link>
      </p>
      <Placeholder />

      <section className="card" aria-labelledby="status-heading">
        <h2 id="status-heading">
          Publishing
          {s.published ? (
            <span className="pill ok">
              {v.demo ? "Demo: would be published" : "Published"}
            </span>
          ) : (
            <span className="pill off">Not published</span>
          )}
        </h2>
        <p>{publishingReason(v)}</p>
        {s.private && (
          <p className="notice" role="note">
            Only Ivora can change this. Contact Ivora support if this network
            should be public.
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="party-heading">
        <h2 id="party-heading">Party ID request</h2>
        <PartyStatus v={v} />
        {v.demo && s.own_party && s.own_party.status !== "approved" && (
          <DemoPartyDecision />
        )}
        {v.demo && (
          <p className="hint muted">
            Demo: {partyLabel(DEMO_TAKEN_PARTY)} belongs to another sample
            operator, to show what happens when a party is already taken.
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="settings-heading">
        <h2 id="settings-heading">Settings</h2>
        {v.sitesError && (
          <p className="error" role="alert">
            Could not list your sites, so they are not shown; sites you
            unpublished before stay unpublished. {v.sitesError}
          </p>
        )}
        {v.sitesTruncated && (
          <p className="notice" role="note">
            Showing the first {(MAX_LIST_PAGES * 100).toLocaleString("en-US")}{" "}
            sites. The others keep their setting.
          </p>
        )}
        {v.otherExcluded.length > 0 && !v.sitesError && (
          <p className="hint muted">
            {v.otherExcluded.length} unpublished{" "}
            {v.otherExcluded.length === 1 ? "site is" : "sites are"} not listed
            here (removed, or past the list) and stay unpublished.
          </p>
        )}
        <RoamingForm
          v={{
            revision: v.revision,
            publish: s.publish,
            private: s.private,
            displayName: s.display_name ?? "",
            website: s.website ?? "",
            timeZone: s.time_zone ?? "",
            countryCode: s.own_party?.country_code ?? "",
            partyId: s.own_party?.party_id ?? "",
            sites: v.sites,
          }}
        />
      </section>

      <section className="card" aria-labelledby="evse-heading">
        <h2 id="evse-heading">
          EVSE IDs <span className="badge">Read only</span>
        </h2>
        <p className="muted">
          Partners know each charging point by its EVSE ID. Ivora generates{" "}
          <code>{partyLabel(s.party)}*E&lt;charger&gt;*&lt;EVSE&gt;</code>{" "}
          unless you moved from another system and Ivora imported the IDs it
          used. Importing needs an approved party ID; ask Ivora support.
        </p>
        {v.evseIdsError ? (
          <p className="error" role="alert">
            {v.evseIdsError}
          </p>
        ) : v.evseIds.length === 0 ? (
          <p className="muted">
            No imported EVSE IDs: every EVSE uses the generated ID.
          </p>
        ) : (
          <div className="table-scroll">
            <table aria-label="Imported EVSE IDs">
              <thead>
                <tr>
                  <th scope="col">Charger</th>
                  <th scope="col">EVSE</th>
                  <th scope="col">EVSE ID</th>
                  <th scope="col">Used now</th>
                </tr>
              </thead>
              <tbody>
                {v.evseIds.map((e) => (
                  <tr key={`${e.station_id}-${e.evse_number}`}>
                    <td>{e.stationName ?? `Charger ${e.station_id}`}</td>
                    <td>{e.evse_number}</td>
                    <td>
                      <code>{e.evse_id}</code>
                    </td>
                    <td>
                      {e.applies ? "Yes" : "No: not under the party in use"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {v.demo && (
        <form action={resetDemoRoamingAction} className="demo-sim">
          <button type="submit" className="button secondary">
            Demo: reset roaming settings
          </button>
        </form>
      )}
    </>
  );
}

/** Checks the role first (a real redirect), then the page behind its loading skeleton. */
export default async function Page() {
  await requireRole("viewer");
  return (
    <Loading shape="list">
      <Content />
    </Loading>
  );
}
