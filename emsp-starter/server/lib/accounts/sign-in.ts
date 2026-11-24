import "server-only";
import { createHash } from "node:crypto";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { rateLimit } from "@/lib/server/rate-limit";
import { createAppToken, type TokenDeps } from "@/lib/tokens/manage";
import type { TokenStore } from "@/lib/tokens/store";
import type { PeerStore } from "@/lib/ocpi/store";
import {
  AuthRateLimitedError,
  type Proof,
  type AuthProvider,
  type AuthSession,
  type AuthUser,
} from "./auth";
import { DEMO_CARD_ID } from "./registry";
import type { AccountStore, Driver } from "./store";
import { logText } from "@/lib/server/log-error";

/**
 * Passwordless sign-in for drivers, from the app and the web, and for admins:
 *
 * 1. `requestCode(email)`: Supabase Auth emails a one-time code (and a link, if your
 *    template has one). The answer is the same whether or not the email has an
 *    account, so it cannot be used to find out who drives with you.
 * 2. `verify(email + code, or the link's token hash)`: a session (access and refresh
 *    tokens). A driver's first sign-in makes their account and app token.
 *
 * Both are rate limited in this server process, per email address, per client address
 * (when a trusted one is known; see clientAddress) and in total; Supabase Auth adds its
 * own limits on emails sent. A limit answers SignInError 429, which says whose limit it
 * was and how long it lasts (`limit`), for a page that explains it.
 *
 * Admin sign-in also waits RESEND_COOLDOWN_MS between two codes for one address, so its
 * page can show when a new code is possible instead of sending a request that fails.
 */
export const SIGN_IN_LIMITS = {
  code: {
    perEmail: { limit: 5, windowMs: 60 * 60_000 },
    perClient: { limit: 20, windowMs: 60 * 60_000 },
    total: { limit: 500, windowMs: 60 * 60_000 },
  },
  verify: {
    perEmail: { limit: 10, windowMs: 15 * 60_000 },
    perClient: { limit: 30, windowMs: 15 * 60_000 },
    total: { limit: 1000, windowMs: 15 * 60_000 },
  },
} as const;

const limiters = {
  code: {
    perEmail: rateLimit(SIGN_IN_LIMITS.code.perEmail),
    perClient: rateLimit(SIGN_IN_LIMITS.code.perClient),
    total: rateLimit(SIGN_IN_LIMITS.code.total),
  },
  verify: {
    perEmail: rateLimit(SIGN_IN_LIMITS.verify.perEmail),
    perClient: rateLimit(SIGN_IN_LIMITS.verify.perClient),
    total: rateLimit(SIGN_IN_LIMITS.verify.total),
  },
};

/**
 * The shortest time between two admin sign-in codes for one address. The same as
 * Supabase Auth's default minimum interval between two emails to one user.
 */
export const RESEND_COOLDOWN_MS = 60_000;
const resendCooldown = rateLimit({ limit: 1, windowMs: RESEND_COOLDOWN_MS });

export function resetSignInLimitsForTests() {
  for (const group of Object.values(limiters))
    for (const l of Object.values(group)) l.reset();
  resendCooldown.reset();
}

/**
 * Whose limit refused a sign-in request: this server's count per email address, per
 * client address or in total, this server's wait between two codes for one address, or
 * the email service's own limit.
 */
export type LimitSource =
  "email" | "client" | "total" | "cooldown" | "email_service";

export type SignInLimit = {
  /** What was limited: asking for a code, or trying one. */
  on: "code" | "verify";
  source: LimitSource;
  /** Seconds until it lifts; null when the email service did not say. */
  retryAfter: number | null;
};

export class SignInError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 400,
    readonly retryAfter?: number,
    /** Set on a 429: the limit that refused the request. */
    readonly limit?: SignInLimit,
  ) {
    super(message);
    this.name = "SignInError";
  }
}

export type SignInDeps = {
  auth: AuthProvider;
  accounts: AccountStore;
  tokens: TokenStore;
  peers: PeerStore;
  now?: () => Date;
};

const EMAIL =
  /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

export function normaliseEmail(input: unknown): string {
  const email = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL.test(email))
    throw new SignInError("Enter a valid email address.");
  return email;
}

/** A per-email key that does not keep the address itself in memory. */
const emailKey = (email: string) =>
  createHash("sha256").update(email).digest("base64url");

const LIMITED = "Too many sign-in attempts. Try again later.";

/** Counts the request against all three limits; refused by the one that lasts longest. */
function limit(on: SignInLimit["on"], email: string, client: string | null) {
  const group = limiters[on];
  const waits: [LimitSource, number | null][] = [
    ["email", group.perEmail.check(emailKey(email))],
    ["client", client === null ? null : group.perClient.check(client)],
    ["total", group.total.check("*")],
  ];
  let worst: { source: LimitSource; retryAfter: number } | undefined;
  for (const [source, wait] of waits)
    if (wait !== null && (!worst || wait > worst.retryAfter))
      worst = { source, retryAfter: wait };
  if (worst)
    throw new SignInError(LIMITED, 429, worst.retryAfter, { on, ...worst });
}

/** The email service refused: its wait when it gave one, else a minute for the header. */
function serviceLimit(e: AuthRateLimitedError, on: SignInLimit["on"]) {
  return new SignInError(e.message, 429, e.retryAfter ?? 60, {
    on,
    source: "email_service",
    retryAfter: e.retryAfter ?? null,
  });
}

/**
 * Sends the sign-in email. Answers the same for every valid address: `resendAfter`,
 * the seconds until this server takes another request for the address, comes from
 * request counts alone, never from whether the address has an account.
 *
 * `resendCooldown` (admin sign-in) refuses a second code for the address within
 * RESEND_COOLDOWN_MS, before the request counts against the hourly limits.
 * `redirectTo` is where the email's link leads, if the template has one; the default is
 * AUTH_REDIRECT_URL, the driver app.
 */
export async function requestCode(
  input: { email: unknown },
  client: string | null,
  deps: Pick<SignInDeps, "auth">,
  options: { resendCooldown?: boolean; redirectTo?: string } = {},
): Promise<{ resendAfter: number }> {
  const email = normaliseEmail(input.email);
  const key = emailKey(email);
  if (options.resendCooldown) {
    const wait = resendCooldown.peek(key);
    if (wait !== null)
      throw new SignInError(LIMITED, 429, wait, {
        on: "code",
        source: "cooldown",
        retryAfter: wait,
      });
  }
  limit("code", email, client);
  if (options.resendCooldown) resendCooldown.check(key);
  try {
    await deps.auth.sendCode(
      email,
      options.redirectTo ?? config.authRedirectUrl,
    );
  } catch (e) {
    if (e instanceof AuthRateLimitedError) throw serviceLimit(e, "code");
    // The same answer as a success: whether an email exists is not ours to tell.
    console.error(`Sending a sign-in code failed: ${logText(e)}`);
  }
  const group = limiters.code;
  return {
    resendAfter: Math.max(
      options.resendCooldown ? (resendCooldown.peek(key) ?? 0) : 0,
      group.perEmail.peek(key) ?? 0,
      client === null ? 0 : (group.perClient.peek(client) ?? 0),
      group.total.peek("*") ?? 0,
    ),
  };
}

const CODE = /^[0-9]{6,10}$/;
const TOKEN_HASH = /^[A-Za-z0-9_-]{16,128}$/;
const LINK_REFUSED = "This sign-in link is invalid or has expired.";

/** Whether `value` has the form of an emailed link's token hash. Says nothing more. */
export const isTokenHash = (value: unknown): value is string =>
  typeof value === "string" && TOKEN_HASH.test(value);

/** Parses what the app sent back: an email and code, or a link's token hash. */
function proofOf(input: {
  email?: unknown;
  code?: unknown;
  tokenHash?: unknown;
}): Proof {
  if (typeof input.tokenHash === "string" && input.tokenHash) {
    if (!TOKEN_HASH.test(input.tokenHash))
      throw new SignInError(LINK_REFUSED, 401);
    return { tokenHash: input.tokenHash };
  }
  const email = normaliseEmail(input.email);
  const code = typeof input.code === "string" ? input.code.trim() : "";
  if (!CODE.test(code)) throw new SignInError("Enter the code from the email.");
  return { email, code };
}

/**
 * The driver's account, made at their first sign-in, with their app token. Safe to
 * call on every sign-in and from concurrent requests.
 */
export async function ensureAccount(
  user: AuthUser,
  deps: SignInDeps,
): Promise<Driver> {
  const now = (deps.now?.() ?? new Date()).toISOString();
  let driver = await deps.accounts.ensureDriver(user.id, user.email, now);
  // Demo accounts pay with the demo card, which charges nothing.
  if (isDemo() && !driver.defaultPaymentMethodId)
    driver =
      (await deps.accounts.updateDriver(
        driver.id,
        { defaultPaymentMethodId: DEMO_CARD_ID },
        now,
      )) ?? driver;
  const tokens = await deps.tokens.listByDriver(user.id);
  if (!tokens.some((t) => t.type === "APP_USER")) {
    const tokenDeps: TokenDeps = {
      tokens: deps.tokens,
      peers: deps.peers,
      actor: `driver:${user.id}`,
      now: deps.now,
    };
    try {
      await createAppToken({ driverRef: user.id }, tokenDeps);
    } catch (e) {
      // A concurrent sign-in made it first: the store refuses a second app token.
      const made = (await deps.tokens.listByDriver(user.id)).some(
        (t) => t.type === "APP_USER",
      );
      if (!made) throw e;
    }
  }
  return driver;
}

/** Checks the email's code or link (rate limited): a session, or SignInError 401. */
export async function verifyProof(
  input: { email?: unknown; code?: unknown; tokenHash?: unknown },
  client: string | null,
  deps: Pick<SignInDeps, "auth">,
): Promise<AuthSession> {
  const proof = proofOf(input);
  limit("verify", "tokenHash" in proof ? proof.tokenHash : proof.email, client);
  let session: AuthSession | null;
  try {
    session = await deps.auth.verify(proof);
  } catch (e) {
    if (e instanceof AuthRateLimitedError) throw serviceLimit(e, "verify");
    throw e;
  }
  if (!session)
    throw new SignInError(
      "tokenHash" in proof
        ? LINK_REFUSED
        : "Wrong or expired code. Ask for a new one.",
      401,
    );
  return session;
}

/** Signs a driver in with the email's code or link: a session, and their account. */
export async function verify(
  input: { email?: unknown; code?: unknown; tokenHash?: unknown },
  client: string | null,
  deps: SignInDeps,
): Promise<{ session: AuthSession; driver: Driver }> {
  const session = await verifyProof(input, client, deps);
  const driver = await ensureAccount(session.user, deps);
  return { session, driver };
}

/** A new session for a refresh token. */
export async function refresh(
  input: { refreshToken?: unknown },
  deps: Pick<SignInDeps, "auth">,
): Promise<AuthSession> {
  const token =
    typeof input.refreshToken === "string" ? input.refreshToken : "";
  if (!token || token.length > 512)
    throw new SignInError("Sign in again.", 401);
  const session = await deps.auth.refresh(token);
  if (!session) throw new SignInError("Sign in again.", 401);
  return session;
}
