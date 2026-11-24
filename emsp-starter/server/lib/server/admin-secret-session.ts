import "server-only";
import { cookies, headers } from "next/headers";
import {
  ADMIN_SECRET_COOKIE,
  adminCookieFlags,
  adminEnabled,
  checkSecretSession,
  issueSecretSession,
} from "./admin";
import { clientAddress } from "./rate-limit";

/**
 * The admin-secret session (lib/server/admin.ts) as this request's cookie: read for
 * the admin gate, set by the sign-in page's exchange, deleted by sign-out and whenever
 * an action finds one that does not work.
 *
 * - "none": no cookie, or ADMIN_SECRET is not set.
 * - "expired", "wrong": the cookie is not a working session. A wrong one is counted.
 * - "limited": too many wrong ones lately, so the cookie was not checked at all.
 */
export type SecretSession = "ok" | "none" | "expired" | "wrong" | "limited";

async function cookieValue(): Promise<string | undefined> {
  try {
    return (await cookies()).get(ADMIN_SECRET_COOKIE)?.value;
  } catch {
    // Outside a request.
    return undefined;
  }
}

/** The request's trusted client address for the limits, or null (see clientAddress). */
export async function requestClient(): Promise<string | null> {
  try {
    return clientAddress(await headers());
  } catch {
    return null;
  }
}

/**
 * The admin-secret session of this request. Each call is one check of the cookie, and
 * a wrong one counts toward the limit on session cookies: ask once per request and
 * pass the answer on (dropDeadSecretSession takes it).
 */
export async function secretSession(): Promise<SecretSession> {
  if (!adminEnabled()) return "none";
  const value = await cookieValue();
  if (!value) return "none";
  return checkSecretSession(value, await requestClient());
}

/**
 * Whether the request carries a cookie that is not a working session: expired, not
 * signed by the secret set now, not checked because of the limit, or left over on a
 * server without ADMIN_SECRET. `session` is this request's answer from secretSession,
 * when the caller has it already; without it the cookie is checked here, once.
 */
export async function hasDeadSecretSession(
  session?: SecretSession,
): Promise<boolean> {
  if (!adminEnabled()) return (await cookieValue()) !== undefined;
  const state = session ?? (await secretSession());
  return state !== "ok" && state !== "none";
}

/**
 * Deletes such a cookie; a working one stays. Like endSecretSession, it can only do so
 * from a server action or a route.
 */
export async function dropDeadSecretSession(
  session?: SecretSession,
): Promise<void> {
  if (await hasDeadSecretSession(session)) await endSecretSession();
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
