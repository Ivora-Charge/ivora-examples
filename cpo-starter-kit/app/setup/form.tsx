"use client";

import { useActionState } from "react";
import { EMPTY } from "@/lib/action-state";
import { setupAction } from "../auth-actions";
import { Result } from "../result";

export function SetupForm({ operatorName }: { operatorName: string }) {
  const [state, action, pending] = useActionState(setupAction, EMPTY);
  return (
    <>
      <Result state={state} />
      <form action={action} className="form">
        <div className="field">
          <label htmlFor="setup-secret">Setup secret</label>
          <input
            id="setup-secret"
            name="secret"
            type="password"
            autoComplete="off"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="setup-operator">Business name</label>
          <input
            id="setup-operator"
            name="operatorName"
            defaultValue={operatorName}
            maxLength={80}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="setup-email">Your email</label>
          <input
            id="setup-email"
            name="email"
            type="email"
            autoComplete="username"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="setup-password">Choose a password</label>
          <input
            id="setup-password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
            aria-describedby="setup-password-hint"
          />
          <span id="setup-password-hint" className="hint">
            At least 12 characters.
          </span>
        </div>
        <div>
          <button type="submit" className="button" disabled={pending}>
            {pending ? "Creating…" : "Create owner"}
          </button>
        </div>
      </form>
    </>
  );
}
