import { notFound } from "next/navigation";
import { may } from "@/lib/hosts";
import {
  assignableRoles,
  atLeast,
  canChangeRole,
  canRemove,
  HOST_ROLE,
  ROLE_LABELS,
  ROLE_SUMMARY,
  ROLES,
} from "@/lib/roles";
import { requireNetworkReader, requireRole } from "@/lib/server/auth";
import { hostStore } from "@/lib/server/hosts";
import { getTeam, loadTeam, type Staff } from "@/lib/server/team";
import { resetDemoAction } from "./actions";
import { InviteForm, MemberActions, RevokeInvite } from "./forms";
import { Loading } from "@/app/loading-skeleton";

export const metadata = { title: "Team" };

const date = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }) + " UTC";

/**
 * Operator staff; a host user only while their host may invite further users (they
 * then see and invite their own host's users only). Anyone else on a host: 404.
 */
async function teamUser(): Promise<Staff> {
  const me = await requireNetworkReader();
  if (me.role !== HOST_ROLE) return requireRole("viewer");
  if (!may(me, "invite")) notFound();
  return me;
}

async function Content() {
  const me = await teamUser();
  const hostView = me.role === HOST_ROLE;
  const { members, invites } = await loadTeam(getTeam(), me);
  const manages = atLeast(me.role, "manager");
  const invites_ = may(me, "invite");
  const grantable = assignableRoles(me.role);
  // Operator staff invite host users for an active host; names for the member list.
  const hosts = hostView
    ? []
    : (await hostStore().list(me.operatorId)).filter((h) => !h.archivedAt);
  const hostName = (id: string | null) =>
    id === me.host?.id
      ? me.host?.name
      : (hosts.find((h) => h.id === id)?.name ?? null);

  return (
    <>
      <h1>Team</h1>

      {invites_ && (
        <section className="card" aria-labelledby="invite-heading">
          <h2 id="invite-heading">Invite someone</h2>
          <p className="muted">
            They get an email with a link that works once and expires in 72
            hours.
            {hostView
              ? ` They join ${me.host?.name} and see what you see.`
              : " A host user sees only their host's sites."}
          </p>
          <InviteForm
            roles={
              hostView
                ? []
                : [
                    ...grantable.map((r): [string, string] => [
                      r,
                      ROLE_LABELS[r],
                    ]),
                    ...(hosts.length
                      ? [[HOST_ROLE, ROLE_LABELS.host] as [string, string]]
                      : []),
                  ]
            }
            hosts={hosts.map((h) => [h.id, h.name])}
          />
        </section>
      )}

      <section className="card" aria-labelledby="staff-heading">
        <h2 id="staff-heading">
          Staff
          {me.demo && <span className="badge">Sample</span>}
        </h2>
        {!manages && (
          <p className="muted">
            {hostView
              ? `The users of ${me.host?.name}. The operator removes users.`
              : "Only owners and managers can change the team."}
          </p>
        )}
        <ul className="rows" aria-label="Staff">
          {members.map((m) => {
            const roleOptions = ROLES.filter(
              (r) => r === m.role || canChangeRole(me, m, r),
            );
            return (
              <li key={m.userId} className="member">
                <div className="member-head">
                  <span className="member-email">{m.email}</span>
                  {m.userId === me.userId && (
                    <span className="muted">(you)</span>
                  )}
                  <span className="role">
                    {ROLE_LABELS[m.role]}
                    {m.hostId && hostName(m.hostId)
                      ? ` · ${hostName(m.hostId)}`
                      : ""}
                  </span>
                </div>
                {(roleOptions.length > 1 || canRemove(me, m)) && (
                  <MemberActions
                    userId={m.userId}
                    email={m.email}
                    role={m.role}
                    roles={roleOptions.map((r) => [r, ROLE_LABELS[r]])}
                    removable={canRemove(me, m)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {invites_ && invites.length > 0 && (
        <section className="card" aria-labelledby="pending-heading">
          <h2 id="pending-heading">Pending invites</h2>
          <ul className="rows" aria-label="Pending invites">
            {invites.map((i) => (
              <li key={i.id}>
                <span className="name">{i.email}</span>
                <span className="role">
                  {ROLE_LABELS[i.role]}
                  {i.hostId && hostName(i.hostId)
                    ? ` · ${hostName(i.hostId)}`
                    : ""}
                </span>
                <span className="muted">Expires {date(i.expiresAt)}</span>
                {(i.role === HOST_ROLE ||
                  grantable.some((r) => r === i.role)) && (
                  <RevokeInvite inviteId={i.id} email={i.email} />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" aria-labelledby="roles-heading">
        <h2 id="roles-heading">Roles</h2>
        <dl className="roles">
          {[...ROLES, HOST_ROLE].map((r) => (
            <div key={r}>
              <dt>{ROLE_LABELS[r]}</dt>
              <dd>{ROLE_SUMMARY[r]}</dd>
            </div>
          ))}
        </dl>
      </section>

      {me.demo && !hostView && (
        <section className="card" aria-labelledby="demo-heading">
          <h2 id="demo-heading">Demo team</h2>
          <p className="muted">
            Changes here are kept in your browser only and are never sent
            anywhere.
          </p>
          <form action={resetDemoAction}>
            <button type="submit" className="button secondary">
              Reset the demo team
            </button>
          </form>
        </section>
      )}
    </>
  );
}

/** Checks the role first (a real redirect), then the page behind its loading skeleton. */
export default async function Page() {
  await teamUser();
  return (
    <Loading shape="list">
      <Content />
    </Loading>
  );
}
