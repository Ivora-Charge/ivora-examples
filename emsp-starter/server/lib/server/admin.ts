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
 * per 15 minutes. While limited, the secret is not even compared. Session cookies that
 * do not check out are limited the same way, on a count of their own. Without a trusted
 * client address (see clientAddress in rate-limit.ts) there is no per-client count and
 * the total cap alone applies. The counts live in this server process, so each instance
 * counts on its own.
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

/**
 * Recent failures of one kind, by client and in total: at most `total` entries, since
 * nothing is checked, and so nothing added, once that many are recent.
 */
function failureLimit() {
  let failures: { at: number; client: string | null }[] = [];
  const recent = (now: number) =>
    (failures = failures.filter((f) => now - f.at < ADMIN_LIMIT.windowMs));
  return {
    limited(client: string | null, now: number): boolean {
      const kept = recent(now);
      return (
        kept.length >= ADMIN_LIMIT.total ||
        (client !== null &&
          kept.filter((f) => f.client === client).length >=
            ADMIN_LIMIT.perClient)
      );
    },
    count(client: string | null, now: number) {
      recent(now).push({ at: now, client });
    },
    /** Forgets what `client` failed, in its own count and in the total. */
    forget(client: string | null) {
      failures = failures.filter((f) => f.client !== client);
    },
    clear() {
      failures = [];
    },
  };
}

/** Wrong secrets submitted on the sign-in page. */
const wrongSecrets = failureLimit();
/** Session cookies that did not check out. Counted apart from wrong secrets. */
const wrongSessions = failureLimit();

/**
 * Checks an admin secret for `client` (a trusted address, or null for none), counting
 * wrong ones. "limited" means too many wrong secrets lately: try again later. While
 * limited, the secret is not compared at all. Only a secret that someone submits is
 * counted here: a session cookie that does not check out has its own count (see
 * checkSecretSession), so a browser's old cookie never stops the secret being taken.
 *
 * A right secret also forgets the session cookies of `client` that did not check out,
 * so that the session it is exchanged for works at once.
 */
export function checkAdminSecret(
  input: unknown,
  client: string | null,
  now = Date.now(),
): "ok" | "wrong" | "limited" {
  if (wrongSecrets.limited(client, now)) return "limited";
  if (isAdminSecret(input)) {
    wrongSessions.forget(client);
    return "ok";
  }
  wrongSecrets.count(client, now);
  return "wrong";
}

/**
 * Whether session cookies from `client` are ignored for now: too many that did not
 * check out, from this client or in total.
 */
export function secretSessionsLimited(
  client: string | null,
  now = Date.now(),
): boolean {
  return wrongSessions.limited(client, now);
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
 * A session cookie is as good as the secret it was signed with: anyone can sign one
 * with a guess at ADMIN_SECRET and see whether it opens the gate. So cookies that do
 * not check out are limited like wrong secrets, 5 per client and 50 in total per 15
 * minutes, and ADMIN_SECRET must be random (openssl rand -base64 32), not a phrase.
 * While that limit is reached, no cookie from the client is checked, a valid one
 * included.
 *
 * The count is separate from the one of wrong secrets. A browser sends its cookie
 * with every request, so after ADMIN_SECRET is changed an old cookie fails again and
 * again: that pauses sessions for its client, never the sign-in page's exchange, and a
 * right secret given there starts the client's count afresh.
 */
export const SECRET_SESSION_MS = 60 * 60 * 1000;
/**
 * The session's cookie: httpOnly, SameSite=Strict, for /admin only and, in production,
 * Secure, like the admin sign-in cookie. It never holds ADMIN_SECRET.
 */
export const ADMIN_SECRET_COOKIE = "emsp_admin_secret_session";
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
 * Checks a session for `client` (a trusted address, or null for none), counting the
 * ones that do not check out.
 * - "expired": signed by this server's secret, but past its time. Not counted: only
 *   someone who had the secret could have made it.
 * - "wrong": anything else that is not a session of this secret, which includes every
 *   session made before the secret was changed. Counted.
 * - "limited": too many wrong ones lately, from this client or in total. Nothing is
 *   compared, so a valid session is not accepted either.
 * Without ADMIN_SECRET there is nothing to guess: "wrong", and nothing is counted.
 */
export function checkSecretSession(
  value: unknown,
  client: string | null,
  now = Date.now(),
): "ok" | "expired" | "wrong" | "limited" {
  const secret = config.adminSecret;
  if (!secret) return "wrong";
  if (wrongSessions.limited(client, now)) return "limited";
  const state = sessionState(secret, value, now);
  if (state === "wrong") wrongSessions.count(client, now);
  return state;
}

function sessionState(
  secret: string,
  value: unknown,
  now: number,
): "ok" | "expired" | "wrong" {
  const parts = typeof value === "string" ? SESSION.exec(value) : null;
  if (!parts) return "wrong";
  const [, expires, nonce, sent] = parts;
  const given = canonical(sent, 32);
  if (!given || !canonical(nonce, NONCE_BYTES)) return "wrong";
  if (!timingSafeEqual(given, sessionMac(secret, expires, nonce)))
    return "wrong";
  return Number(expires) > now ? "ok" : "expired";
}

/**
 * The path both admin cookies are sent to. Every admin page, and so every admin
 * action, is under it; the driver app (/, on the same origin in the one-domain
 * layout), the API and OCPI need neither, and the browser sends them neither.
 *
 * It keeps the cookies out of requests that have no use for them. It is no wall
 * between scripts of one origin: a script on any page of it can still make requests to
 * /admin, which carry them (README: One domain).
 *
 * The cookies' names are not the ones of earlier builds, which set them for every
 * path. A cookie left from such a build is never read, so it cannot stand in for one
 * set now, or stay signed in after a sign-out; it expires within the hour.
 */
export const ADMIN_COOKIE_PATH = "/admin";

/** The flags of both admin cookies: not for page scripts, not for other sites. */
export function adminCookieFlags(expires: Date) {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: ADMIN_COOKIE_PATH,
    expires,
  } as const;
}

export function resetAdminLimitForTests() {
  wrongSecrets.clear();
  wrongSessions.clear();
}
