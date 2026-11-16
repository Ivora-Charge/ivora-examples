import Link from "next/link";
import { HOST_PERMISSIONS, PERMISSION_LABELS } from "@/lib/hosts";
import { atLeast, HOST_ROLE } from "@/lib/roles";
import { requireRole } from "@/lib/server/auth";
import { getHosts, loadHosts, type HostRecord } from "@/lib/server/hosts";
import { getTeam } from "@/lib/server/team";
import { EmptyState } from "@/app/ui/empty-state";
import { PageHeader } from "@/app/ui/page-header";
import { Loading } from "@/app/loading-skeleton";
import { resetDemoHostsAction, viewAsHostAction } from "./actions";
import { ArchiveHost, HostForm, NEW_HOST, SiteHostForm } from "./forms";

export const metadata = { title: "Hosts" };

const permissionSummary = (h: HostRecord) => {
  const on = HOST_PERMISSIONS.filter((p) => h.permissions[p]).map(
    (p) => PERMISSION_LABELS[p].label,
  );
  return on.length ? on.join("; ") : "View only: every switch is off";
};

async function Content() {
  const me = await requireRole("viewer");
  if (!atLeast(me.role, "manager"))
    return (
      <>
        <PageHeader title="Hosts" />
        <section className="card" aria-labelledby="no-access-heading">
          <h2 id="no-access-heading">Owners and managers only</h2>
          <p className="muted">
            Site hosts and what they may do are managed by an owner or a
            manager. Chargers, Live and Reports can be filtered by host.
          </p>
        </section>
      </>
    );
  const [r, members] = await Promise.all([
    loadHosts(await getHosts(), me),
    getTeam().backend.members(me.operatorId),
  ]);
  const active = r.hosts.filter((h) => !h.archivedAt);
  const archived = r.hosts.filter((h) => h.archivedAt);
  const usersOf = (id: string) =>
    members.filter((m) => m.role === HOST_ROLE && m.hostId === id);
  const options: [string, string][] = active.map((h) => [h.id, h.name]);
  return (
    <>
      <PageHeader
        title="Hosts"
        description={`Businesses whose sites carry your chargers. Each host's users see only its sites.${me.demo ? " Sample data." : ""}`}
        action={
          <a className="button" href="#add-host-heading">
            Add host
          </a>
        }
      />
      {me.demo && (
        <p className="notice" role="note">
          Demo: two sample hosts, each with two sample sites. Use <b>View as</b>{" "}
          to see the app as one of their users; nothing is sent anywhere.
        </p>
      )}

      <section className="card" aria-labelledby="hosts-heading">
        <h2 id="hosts-heading">
          Hosts
          {me.demo && <span className="badge">Sample</span>}
        </h2>
        {active.length === 0 ? (
          <EmptyState
            title="No hosts yet"
            action={
              <a className="button" href="#add-host-heading">
                Add your first host
              </a>
            }
          >
            Add a host, then assign its sites below and invite its users from
            the <Link href="/team">Team</Link> page.
          </EmptyState>
        ) : (
          <ul className="rows host-list" aria-label="Hosts">
            {active.map((h) => {
              const sites = r.ok
                ? r.sites.filter((s) => s.hostId === h.id)
                : [];
              const users = usersOf(h.id);
              return (
                <li key={h.id} className="host">
                  <details>
                    <summary>
                      <span className="name">{h.name}</span>
                      <span className="muted">
                        {sites.length} {sites.length === 1 ? "site" : "sites"} ·{" "}
                        {users.length} {users.length === 1 ? "user" : "users"}
                      </span>
                      <span className="muted host-switches">
                        {permissionSummary(h)}
                      </span>
                    </summary>
                    <div className="host-body">
                      {(h.contactName || h.contactEmail || h.contactPhone) && (
                        <p className="muted">
                          Contact:{" "}
                          {[h.contactName, h.contactEmail, h.contactPhone]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      )}
                      {sites.length > 0 && (
                        <p className="muted">
                          Sites: {sites.map((s) => s.name).join(", ")}
                        </p>
                      )}
                      {me.demo &&
                        users.map((u) => (
                          <form key={u.userId} action={viewAsHostAction}>
                            <input
                              type="hidden"
                              name="userId"
                              value={u.userId}
                            />
                            <button type="submit" className="button secondary">
                              View as {u.email}
                            </button>
                          </form>
                        ))}
                      <HostForm
                        host={{
                          id: h.id,
                          name: h.name,
                          contactName: h.contactName ?? "",
                          contactEmail: h.contactEmail ?? "",
                          contactPhone: h.contactPhone ?? "",
                          permissions: h.permissions,
                        }}
                      />
                      <ArchiveHost hostId={h.id} name={h.name} />
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="sites-heading">
        <h2 id="sites-heading">Sites</h2>
        <p className="muted">
          Each site belongs to one host, or to none: then it is your own and no
          host user sees it.
        </p>
        {!r.ok ? (
          <EmptyState
            tone="error"
            title="Sites did not load"
            action={
              <Link className="button" href="/hosts">
                Try again
              </Link>
            }
          >
            {r.error} Nothing was changed.
          </EmptyState>
        ) : r.sites.length === 0 ? (
          <EmptyState title="No sites yet">
            Sites come from your Ivora project. Add a charger with a new site on
            the <Link href="/chargers">Chargers</Link> page.
          </EmptyState>
        ) : (
          <ul className="rows" aria-label="Sites and their hosts">
            {r.truncated && (
              <li className="notice" role="note">
                Showing the first sites Ivora listed.
              </li>
            )}
            {r.sites.map((s) => (
              <li key={s.id} className="site-row">
                <span className="cell-stack">
                  <span className="name">{s.name}</span>
                  {s.address && <span className="muted">{s.address}</span>}
                </span>
                <SiteHostForm
                  siteId={s.id}
                  siteName={s.name}
                  hostId={s.hostId}
                  hosts={options}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="add-host-heading">
        <h2 id="add-host-heading">Add a host</h2>
        <HostForm host={NEW_HOST} />
      </section>

      {archived.length > 0 && (
        <section className="card" aria-labelledby="archived-heading">
          <h2 id="archived-heading">Archived hosts</h2>
          <ul className="rows" aria-label="Archived hosts">
            {archived.map((h) => (
              <li key={h.id}>
                <span className="name">{h.name}</span>
                <span className="muted">No sites, no users</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {me.demo && (
        <form action={resetDemoHostsAction} className="demo-sim">
          <button type="submit" className="button secondary">
            Demo: reset hosts and team to the samples
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
