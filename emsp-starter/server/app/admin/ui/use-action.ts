"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAdmin } from "./admin-context";
import type { ActionResult } from "./kit";

type Action<S> = (prev: S, form: FormData) => Promise<S>;

const FAILED: ActionResult = {
  ok: false,
  message: "The server did not answer. Nothing is known to have changed.",
  code: "no_answer",
  nextStep: "Check your connection, reload the page, then try again.",
};

/**
 * Sends any admin action as the signed-in admin and gives its answer: for a page with
 * several actions on one thing, which shows the answer of the last one.
 */
export function useRun() {
  const { withSecret, check } = useAdmin();
  return useCallback(
    async <S extends ActionResult>(
      action: Action<S>,
      form?: FormData,
    ): Promise<S> => {
      try {
        return check(await action({} as S, withSecret(form)));
      } catch {
        return FAILED as S;
      }
    },
    [withSecret, check],
  );
}

/**
 * Runs one admin server action for the signed-in admin: adds the tab's admin secret
 * (when one was given on the sign-in page), keeps the last answer, and ends the
 * sign-in for this tab when the server no longer accepts it. The actions and the
 * server's gate are the ones every admin form always used; only the secret field is
 * gone from the forms.
 */
export function useAction<S extends ActionResult>(action: Action<S>) {
  const send = useRun();
  const [state, setState] = useState<S>({} as S);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const running = useRef(0);

  const run = useCallback(
    async (form?: FormData): Promise<S> => {
      running.current += 1;
      setPending(true);
      const result = await send(action, form);
      setState(result);
      setDone(true);
      running.current -= 1;
      if (running.current === 0) setPending(false);
      return result;
    },
    [action, send],
  );
  const reset = useCallback(() => setState({} as S), []);
  return { state, run, pending, done, reset, setState };
}

/** A form's fields as FormData, plus the button that sent it (`name` and `value`). */
export const fields = (values: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(values)) form.set(k, v);
  return form;
};

/**
 * A list that opens by itself: runs `action` once an admin is signed in, and again
 * whenever `key` changes (the filters). Nothing runs while nobody is signed in.
 */
export function useList<S extends ActionResult>(
  action: Action<S>,
  values: Record<string, string> = {},
) {
  const { signedIn } = useAdmin();
  const list = useAction(action);
  const { run } = list;
  const key = JSON.stringify(values);
  const reload = useCallback(
    () => run(fields(JSON.parse(key) as Record<string, string>)),
    [run, key],
  );
  useEffect(() => {
    if (signedIn) void reload();
  }, [signedIn, reload]);
  return { ...list, reload, loading: signedIn && !list.done };
}

/**
 * One at a time: while a call of `fn` is still waiting for its answer, another call
 * (a second press of the same or a neighbouring button) does nothing and gives
 * `skipped`. For actions that must not be sent twice, such as a token rotation.
 */
export function oneAtATime<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  skipped: R,
): (...args: A) => Promise<R> {
  let running = false;
  return async (...args: A) => {
    if (running) return skipped;
    running = true;
    try {
      return await fn(...args);
    } finally {
      running = false;
    }
  };
}
