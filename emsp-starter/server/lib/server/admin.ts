import "server-only";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { config } from "./config";

/**
 * The ADMIN_SECRET gate, kept beside admin sign-in (lib/accounts/admin-session.ts) for
 * the first admin and for demo deployments: while ADMIN_SECRET (at least 32
 * characters) is set, whoever gives it on the sign-in page gets an admin-secret session
 * (below), and admin actions run for that session. Unset it once your admins sign in.
 * The comparison takes the same time whatever the input.
 *
 * Wrong secrets given on the sign-in page are rate limited: 5 per client and 50 in total
 * per 15 minutes. While limited, the secret is not even compared. Without a trusted client address (see
 * clientAddress in rate-limit.ts) there is no per-client count and the total cap alone applies. The
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
 * wrong ones. "limited" means too many wrong secrets lately: try again later. While
 * limited, the secret is not compared at all. Only a secret that someone submits is
 * counted here: a session cookie never is (see checkSecretSession).
 */
export function checkAdminSecret(
  input: unknown,
  client: string | null,
  now = Date.now(),
): "ok" | "wrong" | "limited" {
  const key = client === null ? null : `client:${client}`;
  if (failures.size > 4 * ADMIN_LIMIT.total)
    for (const k of [...failures.keys()]) recent(k, now);
  if (
    (key !== null && recent(key, now).length >= ADMIN_LIMIT.perClient) ||
    recent(ALL, now).length >= ADMIN_LIMIT.total
  )
    return "limited";
  if (isAdminSecret(input)) return "ok";
  for (const k of key === null ? [ALL] : [key, ALL])
    failures.set(k, [...recent(k, now), now]);
  return "wrong";
}

/**
 * The admin-secret session: what the sign-in page gets for a right ADMIN_SECRET, so
 * that the secret is typed once and no other request carries it.
 *
 * It is a signed expiry time with a random number,
 * `v1.<expiry, ms>.<nonce>.<HMAC-SHA256>`: the nonce is 128 random bits, the MAC
 * covers `v1.<expiry>.<nonce>`, and its key is derived from ADMIN_SECRET. Nonce and
 * MAC are base64url without padding, and only the one spelling this server writes is
 * accepted. Nothing is stored, so it works on every server instance; changing or
 * unsetting ADMIN_SECRET ends every session at once. It cannot be ended one by one:
 * signing out deletes the browser's cookie, and a copy would work until it expires,
 * which is why it is short and the cookie is httpOnly.
 *
 * A session that does not check out is ignored and never counted as a wrong secret: a
 * browser sends its cookie with every request, so after ADMIN_SECRET is changed an old
 * cookie would otherwise lock its own holder out, and everyone with them. Guessing a
 * session means guessing a 256-bit MAC, which the limit on wrong secrets is not needed
 * for. For the same reason a valid session keeps working while wrong secrets are
 * limited.
 */
export const SECRET_SESSION_MS = 60 * 60 * 1000;
/**
 * The session's cookie: httpOnly, SameSite=Strict and, in production, Secure, like the
 * admin sign-in cookie. It never holds ADMIN_SECRET.
 */
export const ADMIN_SECRET_COOKIE = "emsp_admin_secret";
const SESSION =
  /^v1\.([1-9][0-9]{12,14})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const NONCE_BYTES = 16;

function sessionMac(secret: string, expires: string, nonce: string): Buffer {
  const key = createHmac("sha256", secret)
    .update("emsp admin-secret session key v1")
    .digest();
  return createHmac("sha256", key).update(`v1.${expires}.${nonce}`).digest();
}

/** A new session, or null when ADMIN_SECRET is not set. Call after checkAdminSecret. */
export function issueSecretSession(
  now = Date.now(),
): { value: string; expiresAt: Date } | null {
  const secret = config.adminSecret;
  if (!secret) return null;
  const expires = String(now + SECRET_SESSION_MS);
  const nonce = randomBytes(NONCE_BYTES).toString("base64url");
  const mac = sessionMac(secret, expires, nonce).toString("base64url");
  return {
    value: `v1.${expires}.${nonce}.${mac}`,
    expiresAt: new Date(now + SECRET_SESSION_MS),
  };
}

/** The bytes of `text` when it is their one base64url spelling, else null. */
function canonical(text: string, bytes: number): Buffer | null {
  const decoded = Buffer.from(text, "base64url");
  return decoded.length === bytes && decoded.toString("base64url") === text
    ? decoded
    : null;
}

/**
 * Checks a session. "expired": signed by this server's secret, but past its time.
 * "wrong": anything else that is not a session of this secret, which includes every
 * session made before the secret was changed. Nothing is counted and no limit applies.
 */
export function checkSecretSession(
  value: unknown,
  now = Date.now(),
): "ok" | "expired" | "wrong" {
  const secret = config.adminSecret;
  const parts = typeof value === "string" ? SESSION.exec(value) : null;
  if (!secret || !parts) return "wrong";
  const [, expires, nonce, sent] = parts;
  const given = canonical(sent, 32);
  if (!given || !canonical(nonce, NONCE_BYTES)) return "wrong";
  if (!timingSafeEqual(given, sessionMac(secret, expires, nonce)))
    return "wrong";
  return Number(expires) > now ? "ok" : "expired";
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

export function resetAdminLimitForTests() {
  failures.clear();
}
