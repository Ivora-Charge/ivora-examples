"use client";

import { useActionState } from "react";
import {
  requestAdminCodeAction,
  signOutAdminAction,
  verifyAdminCodeAction,
  type SignInState,
} from "./actions";

function Result({ state }: { state: SignInState }) {
  if (!state.message) return null;
  return (
    <div
      className={state.ok ? "result" : "result error"}
      role={state.ok ? "status" : "alert"}
    >
      <p>{state.message}</p>
    </div>
  );
}

export function SignInForm({ signedIn }: { signedIn: boolean }) {
  const [code, askCode, asking] = useActionState<SignInState, FormData>(
    requestAdminCodeAction,
    {},
  );
  const [verified, verify, verifying] = useActionState<SignInState, FormData>(
    verifyAdminCodeAction,
    {},
  );
  const [out, signOut] = useActionState<SignInState>(signOutAdminAction, {});
  return (
    <>
      <section className="card" aria-labelledby="email-step">
        <h2 id="email-step">1. Get a code</h2>
        <form action={askCode} className="form">
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <div className="actions" aria-busy={asking}>
            <button type="submit">Email me a code</button>
          </div>
        </form>
        <Result state={code} />
      </section>
      <section className="card" aria-labelledby="code-step">
        <h2 id="code-step">2. Enter the code</h2>
        <form action={verify} className="form">
          <label>
            Email
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              defaultValue={code.email}
              key={code.email}
            />
          </label>
          <label>
            Code
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6,10}"
              required
            />
          </label>
          <div className="actions" aria-busy={verifying}>
            <button type="submit">Sign in</button>
          </div>
        </form>
        <Result state={verified} />
      </section>
      {(signedIn || verified.ok) && (
        <section className="card" aria-labelledby="sign-out">
          <h2 id="sign-out">Sign out</h2>
          <form action={signOut} className="form">
            <div className="actions">
              <button type="submit">Sign out</button>
            </div>
          </form>
          <Result state={out} />
        </section>
      )}
    </>
  );
}
