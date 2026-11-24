import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { clientAddress } from "./rate-limit";

/**
 * The ADMIN_SECRET gate, kept beside admin sign-in (lib/accounts/admin-session.ts) for
 * the first admin and for demo deployments: while ADMIN_SECRET (at least 32
 * characters) is set, whoever gives it on the sign-in page gets an admin-secret session
 * (below), and admin actions run for that session. Unset it once your admins sign in.
 * The comparison takes the same time whatever the input.
 *
 * Wrong secrets are rate limited: 5 per client and 50 in total per 15 minutes. While
 * limited, the secret is not even compared. Without a trusted client address (see
 * clientAddress) there is no per-client count and the total cap alone applies. The
 * counts live in this server process, so each instance counts on its own.
 */
export function adminEnabled(): boolean {
  return config.adminSecret !== undefined;
}

export function isAdminSecret(input: unknown): boolean {
  const secret = config.adminSecret;
  if (!secret || typeof input !== "string" || !input) return false;
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(input), digest(secret));
}

export const ADMIN_LIMIT = {
  windowMs: 15 * 60 * 1000,
  perClient: 5,
  total: 50,
} as const;

const ALL = "*";
/** Times of recent wrong secrets, by client and in total. At most `total` entries. */
const failures = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const kept = (failures.get(key) ?? []).filter(
    (t) => now - t < ADMIN_LIMIT.windowMs,
  );
  if (kept.length) failures.set(key, kept);
  else failures.delete(key);
  return kept;
}

/**
 * Checks an admin secret for `client` (a trusted address, or null for none), counting
 * wrong ones. "limited" means too many wrong secrets lately: try again later.
 */
export function checkAdminSecret(
  input: unknown,
  client: string | null,
  now = Date.now(),
): "ok" | "wrong" | "limited" {
  return attempt(() => (isAdminSecret(input) ? "ok" : "wrong"), client, now);
}

/**
 * One try at proving knowledge of the secret, by the secret itself or by a session made
 * from it. While limited, `proof` is not run at all; a "wrong" one is counted.
 */
function attempt<T extends string>(
  proof: () => T | "wrong",
  client: string | null,
  now: number,
): T | "wrong" | "limited" {
  const key = client === null ? null : `client:${client}`;
  if (failures.size > 4 * ADMIN_LIMIT.total)
    for (const k of [...failures.keys()]) recent(k, now);
  if (
    (key !== null && recent(key, now).length >= ADMIN_LIMIT.perClient) ||
    recent(ALL, now).length >= ADMIN_LIMIT.total
  )
    return "limited";
  const result = proof();
  if (result === "wrong")
    for (const k of key === null ? [ALL] : [key, ALL])
      failures.set(k, [...recent(k, now), now]);
  return result;
}

/**
 * The admin-secret session: what the sign-in page gets for a right ADMIN_SECRET, so
 * that the secret is typed once and no other request carries it.
 *
 * It is a signed expiry time, `v1.<expiry, ms>.<HMAC-SHA256>`, with a key derived from
 * ADMIN_SECRET. Nothing is stored, so it works on every server instance; changing or
 * unsetting ADMIN_SECRET ends every session at once. It cannot be ended one by one:
 * signing out deletes the browser's cookie, and a copy would work until it expires,
 * which is why it is short and the cookie is httpOnly.
 *
 * A session with a wrong signature is a guess at the secret like any other: it is
 * counted by the same limit as a wrong secret, and while limited no session is checked.
 */
export const SECRET_SESSION_MS = 60 * 60 * 1000;
/**
 * The session's cookie: httpOnly, SameSite=Strict and, in production, Secure, like the
 * admin sign-in cookie. It never holds ADMIN_SECRET.
 */
export const ADMIN_SECRET_COOKIE = "emsp_admin_secret";
const SESSION = /^v1\.([0-9]{13,15})\.([A-Za-z0-9_-]{43})$/;

function sessionMac(secret: string, expires: string): Buffer {
  const key = createHmac("sha256", secret)
    .update("emsp admin-secret session key v1")
    .digest();
  return createHmac("sha256", key).update(`v1.${expires}`).digest();
}

/** A new session, or null when ADMIN_SECRET is not set. Call after checkAdminSecret. */
export function issueSecretSession(
  now = Date.now(),
): { value: string; expiresAt: Date } | null {
  const secret = config.adminSecret;
  if (!secret) return null;
  const expires = String(now + SECRET_SESSION_MS);
  return {
    value: `v1.${expires}.${sessionMac(secret, expires).toString("base64url")}`,
    expiresAt: new Date(now + SECRET_SESSION_MS),
  };
}

/**
 * Checks a session for `client`. "expired": signed by this server's secret, but past
 * its time (not counted). "wrong": anything else that is not a session of this secret
 * (counted). "limited": too many wrong secrets or sessions lately; not checked.
 */
export function checkSecretSession(
  value: unknown,
  client: string | null,
  now = Date.now(),
): "ok" | "expired" | "wrong" | "limited" {
  return attempt(
    () => {
      const secret = config.adminSecret;
      const parts = typeof value === "string" ? SESSION.exec(value) : null;
      if (!secret || !parts) return "wrong";
      const given = Buffer.from(parts[2], "base64url");
      const mac = sessionMac(secret, parts[1]);
      if (given.length !== mac.length || !timingSafeEqual(given, mac))
        return "wrong";
      return Number(parts[1]) > now ? "ok" : "expired";
    },
    client,
    now,
  );
}

/** The flags of both admin cookies: not for page scripts, not for other sites. */
export function adminCookieFlags(expires: Date) {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  } as const;
}

/** The client key for the admin-secret rate limit: see clientAddress. */
export const adminClientKey = clientAddress;

export function resetAdminLimitForTests() {
  failures.clear();
}
