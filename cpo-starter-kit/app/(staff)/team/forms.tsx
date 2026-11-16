"use client";

import { useActionState, useId } from "react";
import { EMPTY } from "@/lib/action-state";
import { Result } from "../result";
import {
  changeRoleAction,
  inviteAction,
  removeAction,
  revokeInviteAction,
} from "./actions";

type Option = [value: string, label: string];

export function InviteForm({
  roles,
  hosts = [],
}: {
  /** Roles to choose from; none (a host user's form) invites for their own host. */
  roles: Option[];
  /** Hosts a host user can be invited for (with the Host role). */
  hosts?: Option[];
}) {
  const [state, action, pending] = useActionState(inviteAction, EMPTY);
  const id = useId();
  return (
    <>
      <Result state={state} />
      <form action={action} className="form">
        <div className="field">
          <label htmlFor={`${id}-email`}>Email</label>
          <input
            id={`${id}-email`}
            name="email"
            type="email"
            autoComplete="off"
            required
            maxLength={254}
          />
        </div>
        {roles.length > 0 && (
          <div className="field">
            <label htmlFor={`${id}-role`}>Role</label>
            <select
              id={`${id}-role`}
              name="role"
              defaultValue={roles.find(([v]) => v !== "host")?.[0]}
            >
              {roles.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        )}
        {hosts.length > 0 && (
          <div className="field">
            <label htmlFor={`${id}-host`}>Host (for the Host role)</label>
            <select id={`${id}-host`} name="hostId" defaultValue="">
              <option value="">Choose a host</option>
              {hosts.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <button type="submit" className="button" disabled={pending}>
            {pending ? "Sending…" : "Send invite"}
          </button>
        </div>
      </form>
    </>
  );
}

export function MemberActions(p: {
  userId: string;
  email: string;
  role: string;
  roles: Option[];
  removable: boolean;
}) {
  const [roleState, roleFormAction, rolePending] = useActionState(
    changeRoleAction,
    EMPTY,
  );
  const [removeState, removeFormAction, removePending] = useActionState(
    removeAction,
    EMPTY,
  );
  const id = useId();
  return (
    <>
      <Result state={roleState} />
      <Result state={removeState} />
      <div className="member-actions">
        {p.roles.length > 1 && (
          <form action={roleFormAction} className="member-actions">
            <input type="hidden" name="userId" value={p.userId} />
            <label htmlFor={`${id}-role`} className="role">
              Role for {p.email}
            </label>
            <select id={`${id}-role`} name="role" defaultValue={p.role}>
              {p.roles.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="button secondary"
              disabled={rolePending}
            >
              Change role
            </button>
          </form>
        )}
        {p.removable && (
          <form
            action={removeFormAction}
            onSubmit={(e) => {
              if (!confirm(`Remove ${p.email} from the team?`))
                e.preventDefault();
            }}
          >
            <input type="hidden" name="userId" value={p.userId} />
            <button
              type="submit"
              className="button danger"
              disabled={removePending}
              aria-label={`Remove ${p.email}`}
            >
              Remove
            </button>
          </form>
        )}
      </div>
    </>
  );
}

export function RevokeInvite(p: { inviteId: string; email: string }) {
  const [state, action, pending] = useActionState(revokeInviteAction, EMPTY);
  return (
    <>
      <Result state={state} />
      <form action={action}>
        <input type="hidden" name="inviteId" value={p.inviteId} />
        <button
          type="submit"
          className="button secondary"
          disabled={pending}
          aria-label={`Revoke invite for ${p.email}`}
        >
          Revoke
        </button>
      </form>
    </>
  );
}
