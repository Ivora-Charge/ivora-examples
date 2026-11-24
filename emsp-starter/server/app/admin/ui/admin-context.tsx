"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ActionResult } from "./kit";

/** Who the server says is signed in: from the admin cookie, read by the root layout. */
export type Who = { email: string; role: "admin" | "viewer" } | null;

type AdminContext = {
  admin: Who;
  demo: boolean;
  /** The server found an admin-secret session (its httpOnly cookie) on this request. */
  hasSecret: boolean;
  /** An admin is signed in by email, or with an admin-secret session. */
  signedIn: boolean;
  /** The server stopped accepting this sign-in (the session ran out). */
  ended: boolean;
  /** A new sign-in succeeded: forget that the last one ended. */
  renew: () => void;
  /** Looks at an action's answer: a refused sign-in ends it for this tab. */
  check: <S extends ActionResult>(result: S) => S;
  /** The address the last sign-in code was asked for, for the first-admin statement. */
  lastEmail: string | null;
  setLastEmail: (email: string | null) => void;
};

const Ctx = createContext<AdminContext | null>(null);

/** The gate's answers that mean "nobody is signed in" (lib/server/admin-action.ts). */
const SIGNED_OUT = new Set(["admin_disabled", "signed_out", "session_expired"]);

/**
 * The sign-in state every admin page shares. Both ways of signing in are an httpOnly
 * cookie that only the server reads (lib/server/admin-action.ts): the root layout says
 * who it found, and nothing about a sign-in is kept in the page. No form carries a
 * secret: ADMIN_SECRET is typed once, on the sign-in page, and exchanged there for a
 * session.
 */
export function AdminProvider({
  admin,
  secret = false,
  demo,
  children,
}: {
  admin: Who;
  /** An admin-secret session is in use. */
  secret?: boolean;
  demo: boolean;
  children: ReactNode;
}) {
  const [ended, setEnded] = useState(false);
  const [lastEmail, setLastEmail] = useState<string | null>(null);
  const renew = useCallback(() => setEnded(false), []);

  const check = useCallback(<S extends ActionResult>(result: S): S => {
    if (result.code && SIGNED_OUT.has(result.code)) setEnded(true);
    return result;
  }, []);

  const value = useMemo<AdminContext>(
    () => ({
      admin,
      demo,
      hasSecret: secret,
      signedIn: (admin !== null || secret) && !ended,
      ended,
      renew,
      check,
      lastEmail,
      setLastEmail,
    }),
    [admin, demo, secret, ended, renew, check, lastEmail],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAdmin(): AdminContext {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error("useAdmin needs the AdminProvider of app/layout.tsx");
  return ctx;
}
