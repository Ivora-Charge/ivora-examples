"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { EMPTY, type ActionState } from "@/lib/action-state";
import { acceptInviteAction, lookupInviteAction } from "../auth-actions";
import { Result } from "../result";
import { useFragmentToken } from "../use-fragment-token";

export function AcceptInvite({ demo }: { demo: boolean }) {
  const token = useFragmentToken();
  const [lookup, setLookup] = useState<ActionState | null>(null);
  const [state, action, pending] = useActionState(acceptInviteAction, EMPTY);

  useEffect(() => {
    if (token === undefined) return;
    if (token === null) {
      setLookup({
        error: "Open this page from the link in your invite email.",
      });
      return;
    }
    let live = true;
    lookupInviteAction(token).then((r) => live && setLookup(r));
    return () => {
      live = false;
    };
  }, [token]);

  if (!lookup) return <p className="muted">Checking your invite…</p>;
  if (lookup.error || !lookup.invite) return <Result state={lookup} />;
  if (state.ok)
    return (
      <section className="card">
        <Result state={state} />
        <Link className="button" href="/team">
          See the team
        </Link>
      </section>
    );

  const inv = lookup.invite;
  return (
    <section className="card" aria-labelledby="accept-heading">
      <h2 id="accept-heading">
        {inv.operatorName}
        {demo && <span className="badge">Demo</span>}
      </h2>
      <p>
        You are invited as <strong>{inv.role}</strong>. Choose a password to
        finish.
      </p>
      {demo && (
        <p className="notice" role="note">
          Demo mode: the password is checked but not stored, and you stay signed
          in as the demo owner.
        </p>
      )}
      <Result state={state} />
      <form action={action} className="form">
        <input type="hidden" name="token" value={token ?? ""} />
        <div className="field">
          <label htmlFor="invite-email">Email</label>
          <input
            id="invite-email"
            name="email"
            type="email"
            autoComplete="username"
            value={inv.email}
            readOnly
          />
        </div>
        <div className="field">
          <label htmlFor="invite-password">Password</label>
          <input
            id="invite-password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
            aria-describedby="invite-password-hint"
          />
          <span id="invite-password-hint" className="hint">
            At least 12 characters.
          </span>
        </div>
        <div>
          <button type="submit" className="button" disabled={pending}>
            {pending ? "Joining…" : "Join the team"}
          </button>
        </div>
      </form>
    </section>
  );
}
