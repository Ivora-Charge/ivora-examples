import "server-only";
import { cookies, headers } from "next/headers";
import {
  ADMIN_SECRET_COOKIE,
  adminClientKey,
  adminCookieFlags,
  adminEnabled,
  checkSecretSession,
  issueSecretSession,
} from "./admin";

/**
 * The admin-secret session (lib/server/admin.ts) as this request's cookie: read for
 * the admin gate, set by the sign-in page's exchange, deleted by sign-out.
 */
export type SecretSession = "ok" | "none" | "expired" | "wrong" | "limited";

/**
 * The admin-secret session of this request. "none": no cookie, or ADMIN_SECRET is not
 * set (nothing is checked or counted). Outside a request: "none".
 */
export async function secretSession(): Promise<SecretSession> {
  if (!adminEnabled()) return "none";
  let value: string | undefined;
  let client: string | null = null;
  try {
    value = (await cookies()).get(ADMIN_SECRET_COOKIE)?.value;
    client = adminClientKey(await headers());
  } catch {
    return "none";
  }
  if (!value) return "none";
  return checkSecretSession(value, client);
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
