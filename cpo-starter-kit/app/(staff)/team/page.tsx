import {
  assignableRoles,
  atLeast,
  canChangeRole,
  canRemove,
  ROLE_LABELS,
  ROLE_SUMMARY,
  ROLES,
} from "@/lib/roles";
import { requireRole } from "@/lib/server/auth";
import { getTeam, loadTeam } from "@/lib/server/team";
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

async function Content() {
  const me = await requireRole("viewer");
  const { members, invites } = await loadTeam(getTeam(), me);
  const manages = atLeast(me.role, "manager");
  const grantable = assignableRoles(me.role);

  return (
    <>
      <h1>Team</h1>

      {manages && (
        <section className="card" aria-labelledby="invite-heading">
          <h2 id="invite-heading">Invite someone</h2>
          <p className="muted">
            They get an email with a link that works once and expires in 72
            hours.
          </p>
          <InviteForm roles={grantable.map((r) => [r, ROLE_LABELS[r]])} />
        </section>
      )}

      <section className="card" aria-labelledby="staff-heading">
        <h2 id="staff-heading">
          Staff
          {me.demo && <span className="badge">Sample</span>}
        </h2>
        {!manages && (
          <p className="muted">Only owners and managers can change the team.</p>
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
                  <span className="role">{ROLE_LABELS[m.role]}</span>
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

      {manages && invites.length > 0 && (
        <section className="card" aria-labelledby="pending-heading">
          <h2 id="pending-heading">Pending invites</h2>
          <ul className="rows" aria-label="Pending invites">
            {invites.map((i) => (
              <li key={i.id}>
                <span className="name">{i.email}</span>
                <span className="role">{ROLE_LABELS[i.role]}</span>
                <span className="muted">Expires {date(i.expiresAt)}</span>
                {grantable.includes(i.role) && (
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
          {ROLES.map((r) => (
            <div key={r}>
              <dt>{ROLE_LABELS[r]}</dt>
              <dd>{ROLE_SUMMARY[r]}</dd>
            </div>
          ))}
        </dl>
      </section>

      {me.demo && (
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

/** The page behind its loading skeleton. */
export default function Page() {
  return (
    <Loading shape="list">
      <Content />
    </Loading>
  );
}
