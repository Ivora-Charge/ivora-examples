import "server-only";
import { cookies } from "next/headers";
import {
  ADMIN_SECRET_COOKIE,
  adminCookieFlags,
  adminEnabled,
  checkSecretSession,
  issueSecretSession,
} from "./admin";

/**
 * The admin-secret session (lib/server/admin.ts) as this request's cookie: read for
 * the admin gate, set by the sign-in page's exchange, deleted by sign-out and whenever
 * an action finds one that no longer works.
 */
export type SecretSession = "ok" | "none" | "expired" | "wrong";

async function cookieValue(): Promise<string | undefined> {
  try {
    return (await cookies()).get(ADMIN_SECRET_COOKIE)?.value;
  } catch {
    // Outside a request.
    return undefined;
  }
}

/**
 * The admin-secret session of this request. "none": no cookie, or ADMIN_SECRET is not
 * set. Reading it counts nothing: a cookie that does not check out ("wrong", for
 * example one from before ADMIN_SECRET was changed, or "expired") is only ignored.
 */
export async function secretSession(): Promise<SecretSession> {
  if (!adminEnabled()) return "none";
  const value = await cookieValue();
  if (!value) return "none";
  return checkSecretSession(value);
}

/**
 * Whether the request carries a cookie that is not a working session: expired, not
 * signed by the secret set now, or left over on a server without ADMIN_SECRET.
 */
export async function hasDeadSecretSession(): Promise<boolean> {
  const value = await cookieValue();
  if (!value) return false;
  return !adminEnabled() || checkSecretSession(value) !== "ok";
}

/**
 * Deletes such a cookie; a working one stays. Like endSecretSession, it can only do so
 * from a server action or a route.
 */
export async function dropDeadSecretSession(): Promise<void> {
  if (await hasDeadSecretSession()) await endSecretSession();
}

/** Starts a session for whoever just gave the right secret. False without ADMIN_SECRET. */
export async function startSecretSession(): Promise<boolean> {
  const session = issueSecretSession();
  if (!session) return false;
  (await cookies()).set(
    ADMIN_SECRET_COOKIE,
    session.value,
    adminCookieFlags(session.expiresAt),
  );
  return true;
}

/**
 * Deletes the cookie. Only a server action or a route can; while a page renders this
 * does nothing, and the browser drops the cookie when it expires.
 */
export async function endSecretSession(): Promise<void> {
  try {
    (await cookies()).delete(ADMIN_SECRET_COOKIE);
  } catch {}
}
