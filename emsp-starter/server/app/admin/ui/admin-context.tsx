"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ActionResult } from "./kit";

/** Who the server says is signed in: from the admin cookie, read by the root layout. */
export type Who = { email: string; role: "admin" | "viewer" } | null;

type AdminContext = {
  admin: Who;
  demo: boolean;
  /** The admin secret was typed on the sign-in page in this tab. */
  hasSecret: boolean;
  /** An admin is signed in, or the admin secret is held for this tab. */
  signedIn: boolean;
  /** The server stopped accepting this sign-in (the session ran out). */
  ended: boolean;
  setSecret: (secret: string | null) => void;
  /** A new sign-in succeeded: forget that the last one ended. */
  renew: () => void;
  /** The form with the tab's admin secret added, as every admin action takes it. */
  withSecret: (form?: FormData) => FormData;
  /** Looks at an action's answer: a refused sign-in ends it for this tab. */
  check: <S extends ActionResult>(result: S) => S;
  /** The address the last sign-in code was asked for, for the first-admin statement. */
  lastEmail: string | null;
  setLastEmail: (email: string | null) => void;
};

const Ctx = createContext<AdminContext | null>(null);

/**
 * The sign-in state every admin page shares. The server's admin gate is unchanged
 * (lib/server/admin-action.ts): an action runs for a signed-in admin (the httpOnly
 * cookie), or for whoever sends ADMIN_SECRET in the form's `adminSecret` field.
 *
 * The secret is asked once, on the sign-in page, and kept here: in this component's
 * memory only. It is never written to a cookie, localStorage or sessionStorage, so it
 * is gone when the tab closes or reloads.
 */
export function AdminProvider({
  admin,
  demo,
  children,
}: {
  admin: Who;
  demo: boolean;
  children: ReactNode;
}) {
  const secret = useRef<string | null>(null);
  const [hasSecret, setHasSecret] = useState(false);
  const [ended, setEnded] = useState(false);
  const [lastEmail, setLastEmail] = useState<string | null>(null);

  const setSecret = useCallback((value: string | null) => {
    secret.current = value;
    setHasSecret(value !== null);
    setEnded(false);
  }, []);
  const renew = useCallback(() => setEnded(false), []);

  const withSecret = useCallback((form?: FormData) => {
    const out = new FormData();
    if (form) for (const [k, v] of form.entries()) out.append(k, v);
    out.delete("adminSecret");
    if (secret.current !== null) out.set("adminSecret", secret.current);
    return out;
  }, []);

  const check = useCallback(<S extends ActionResult>(result: S): S => {
    // "admin_disabled": nobody is signed in and no secret is set on the server.
    // "wrong_secret": nobody is signed in and the secret we sent (or none) is wrong.
    if (result.code === "admin_disabled" || result.code === "wrong_secret") {
      if (secret.current !== null) {
        secret.current = null;
        setHasSecret(false);
      }
      setEnded(true);
    }
    return result;
  }, []);

  const value = useMemo<AdminContext>(
    () => ({
      admin,
      demo,
      hasSecret,
      signedIn: (admin !== null || hasSecret) && !ended,
      ended,
      setSecret,
      renew,
      withSecret,
      check,
      lastEmail,
      setLastEmail,
    }),
    [
      admin,
      demo,
      hasSecret,
      ended,
      setSecret,
      renew,
      withSecret,
      check,
      lastEmail,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAdmin(): AdminContext {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error("useAdmin needs the AdminProvider of app/layout.tsx");
  return ctx;
}
