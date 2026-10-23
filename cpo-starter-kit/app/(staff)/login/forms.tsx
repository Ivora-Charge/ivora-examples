"use client";

import { useActionState } from "react";
import { EMPTY } from "@/lib/action-state";
import { signInAction, signInLinkAction } from "../auth-actions";
import { Result } from "../result";

export function PasswordForm() {
  const [state, action, pending] = useActionState(signInAction, EMPTY);
  return (
    <>
      <Result state={state} />
      <form action={action} className="form">
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="username"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        <div>
          <button type="submit" className="button" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
    </>
  );
}

export function LinkForm() {
  const [state, action, pending] = useActionState(signInLinkAction, EMPTY);
  return (
    <>
      <Result state={state} />
      <form action={action} className="form">
        <div className="field">
          <label htmlFor="link-email">Email</label>
          <input
            id="link-email"
            name="email"
            type="email"
            autoComplete="email"
            required
          />
        </div>
        <div>
          <button type="submit" className="button secondary" disabled={pending}>
            {pending ? "Sending…" : "Email me a link"}
          </button>
        </div>
      </form>
    </>
  );
}
