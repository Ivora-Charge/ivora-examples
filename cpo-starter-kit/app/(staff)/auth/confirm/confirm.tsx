"use client";

import { useActionState } from "react";
import { EMPTY } from "@/lib/action-state";
import { confirmLinkAction } from "../../auth-actions";
import { Result } from "../../result";
import { useFragmentToken } from "../../use-fragment-token";

export function ConfirmSignIn() {
  const token = useFragmentToken();
  const [state, action, pending] = useActionState(confirmLinkAction, EMPTY);
  if (token === undefined) return null;
  if (token === null)
    return (
      <Result
        state={{ error: "Open this page from the link in your sign-in email." }}
      />
    );
  return (
    <section className="card">
      <Result state={state} />
      <form action={action}>
        <input type="hidden" name="token" value={token} />
        <button type="submit" className="button" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </section>
  );
}
