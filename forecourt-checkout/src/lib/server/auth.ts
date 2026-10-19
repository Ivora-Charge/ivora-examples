import "server-only";
import { cookies } from "next/headers";
import type { Settings } from "../settings";
import { signToken, verifyToken } from "../tokens";
import { signingSecret } from "./services";

export const OPERATOR_COOKIE = "fc_operator";
export const GUEST_COOKIE = "fc_guest";
const OPERATOR_TTL_MS = 12 * 60 * 60 * 1000;
const GUEST_TTL_MS = 2 * 24 * 60 * 60 * 1000;

export function operatorToken(settings: Settings, now = Date.now()) {
  return signToken(
    signingSecret(settings),
    "operator",
    "site",
    now + OPERATOR_TTL_MS,
  );
}

export async function isOperator(settings: Settings) {
  const value = (await cookies()).get(OPERATOR_COOKIE)?.value;
  return verifyToken(signingSecret(settings), "operator", value) === "site";
}

export function cookieOptions(maxAgeMs: number, secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

export const operatorCookie = (settings: Settings) =>
  cookieOptions(OPERATOR_TTL_MS, !settings.demo);

/** Only the phone that paid may stop its session. */
export function guestToken(
  settings: Settings,
  sessionId: string,
  now = Date.now(),
) {
  return signToken(
    signingSecret(settings),
    "guest",
    sessionId,
    now + GUEST_TTL_MS,
  );
}

export const guestCookie = (settings: Settings) =>
  cookieOptions(GUEST_TTL_MS, !settings.demo);

export async function isGuestOf(settings: Settings, sessionId: string) {
  const value = (await cookies()).get(GUEST_COOKIE)?.value;
  return verifyToken(signingSecret(settings), "guest", value) === sessionId;
}

// Best-effort brute-force brake per server instance; put a WAF rule in front for more.
const attempts = new Map<string, { count: number; since: number }>();
export function loginAllowed(key: string, now = Date.now()) {
  const entry = attempts.get(key);
  if (!entry || now - entry.since > 15 * 60 * 1000) {
    attempts.set(key, { count: 1, since: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= 10;
}
