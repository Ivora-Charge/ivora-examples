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
 * own limits on emails sent. A limit answers SignInError 429.
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

export function resetSignInLimitsForTests() {
  for (const group of Object.values(limiters))
    for (const l of Object.values(group)) l.reset();
}

export class SignInError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 400,
    readonly retryAfter?: number,
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

function limit(
  group: (typeof limiters)["code"],
  email: string,
  client: string | null,
) {
  const waits = [
    group.perEmail.check(emailKey(email)),
    client === null ? null : group.perClient.check(client),
    group.total.check("*"),
  ].filter((w): w is number => w !== null);
  if (waits.length)
    throw new SignInError(
      "Too many sign-in attempts. Try again later.",
      429,
      Math.max(...waits),
    );
}

/** Sends the sign-in email. Answers the same for every valid address. */
export async function requestCode(
  input: { email: unknown },
  client: string | null,
  deps: Pick<SignInDeps, "auth">,
): Promise<void> {
  const email = normaliseEmail(input.email);
  limit(limiters.code, email, client);
  try {
    await deps.auth.sendCode(email, config.authRedirectUrl);
  } catch (e) {
    if (e instanceof AuthRateLimitedError)
      throw new SignInError(e.message, 429, 60);
    // The same answer as a success: whether an email exists is not ours to tell.
    console.error(
      `Sending a sign-in code failed: ${e instanceof Error ? e.name : "unknown error"}`,
    );
  }
}

const CODE = /^[0-9]{6,10}$/;
const TOKEN_HASH = /^[A-Za-z0-9_-]{16,128}$/;

/** Parses what the app sent back: an email and code, or a link's token hash. */
function proofOf(input: {
  email?: unknown;
  code?: unknown;
  tokenHash?: unknown;
}): Proof {
  if (typeof input.tokenHash === "string" && input.tokenHash) {
    if (!TOKEN_HASH.test(input.tokenHash))
      throw new SignInError(
        "This sign-in link is invalid or has expired.",
        401,
      );
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
  limit(
    limiters.verify,
    "tokenHash" in proof ? proof.tokenHash : proof.email,
    client,
  );
  let session: AuthSession | null;
  try {
    session = await deps.auth.verify(proof);
  } catch (e) {
    if (e instanceof AuthRateLimitedError)
      throw new SignInError(e.message, 429, 60);
    throw e;
  }
  if (!session)
    throw new SignInError("Wrong or expired code. Ask for a new one.", 401);
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
