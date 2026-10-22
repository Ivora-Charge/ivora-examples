"use client";

import { useActionState, type ReactNode } from "react";

/**
 * What every admin action returns: a message, plus whatever its form shows. A failure
 * also has a code (the CPO's OCPI status code when it gave one) and a next step.
 */
export type CardState = {
  ok?: boolean;
  message?: string;
  code?: string;
  nextStep?: string;
};

/** The code and next step of a failure, under its message. */
export function ErrorHelp({ code, nextStep }: CardState) {
  if (!code && !nextStep) return null;
  return (
    <dl className="facts error-help">
      {code && (
        <>
          <dt>Code</dt>
          <dd>
            <code>{code}</code>
          </dd>
        </>
      )}
      {nextStep && (
        <>
          <dt>Next step</dt>
          <dd>{nextStep}</dd>
        </>
      )}
    </dl>
  );
}

/** Only asked when the admin is not signed in (ADMIN_SECRET deployments). */
function SecretField() {
  return (
    <label>
      Admin secret
      <input
        name="adminSecret"
        type="password"
        autoComplete="current-password"
      />
      <span className="muted">Leave empty when you are signed in.</span>
    </label>
  );
}

/** One admin action: a form (with the admin secret field), and its result below. */
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
  /** The fields; a function gets the last result, e.g. to keep a list's filters. */
  children?: ReactNode | ((state: S) => ReactNode);
  /** The buttons; the first is the one Enter presses. */
  submit: ReactNode | ((state: S) => ReactNode);
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
        {typeof children === "function" ? children(state) : children}
        <SecretField />
        <div className="actions" aria-busy={pending}>
          {typeof submit === "function" ? submit(state) : submit}
        </div>
      </form>
      {state.message && (
        <div
          className={state.ok ? "result" : "result error"}
          role={state.ok ? "status" : "alert"}
        >
          <p>{state.message}</p>
          {!state.ok && (
            <ErrorHelp code={state.code} nextStep={state.nextStep} />
          )}
          {details?.(state)}
        </div>
      )}
    </section>
  );
}
