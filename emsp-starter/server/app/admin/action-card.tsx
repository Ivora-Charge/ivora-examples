"use client";

import { useActionState, type ReactNode } from "react";

/** What every admin action returns: a message, plus whatever its form shows. */
export type CardState = { ok?: boolean; message?: string };

function SecretField() {
  return (
    <label>
      Admin secret
      <input
        name="adminSecret"
        type="password"
        autoComplete="current-password"
        required
      />
    </label>
  );
}

/** One admin action: a form with the admin secret, and its result below. */
export function ActionCard<S extends CardState>({
  id,
  title,
  action,
  children,
  submit,
  details,
}: {
  id: string;
  title: string;
  action: (prev: S, form: FormData) => Promise<S>;
  children?: ReactNode;
  submit: ReactNode;
  /** What the result shows beside its message. */
  details?: (state: S) => ReactNode;
}) {
  const [state, formAction, pending] = useActionState<S, FormData>(
    action,
    {} as Awaited<S>,
  );
  return (
    <section className="card" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <form action={formAction} className="form">
        {children}
        <SecretField />
        <div className="actions" aria-busy={pending}>
          {submit}
        </div>
      </form>
      {state.message && (
        <div
          className={state.ok ? "result" : "result error"}
          role={state.ok ? "status" : "alert"}
        >
          <p>{state.message}</p>
          {details?.(state)}
        </div>
      )}
    </section>
  );
}
