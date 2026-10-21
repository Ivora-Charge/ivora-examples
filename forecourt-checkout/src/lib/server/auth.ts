import "server-only";
import { createHmac } from "node:crypto";
import { cookies } from "next/headers";
import type { Settings } from "../settings";
import { signToken, verifyToken } from "../tokens";
import { cashierPassword, signingSecret } from "./services";

export const OPERATOR_COOKIE = "fc_operator";
export const GUEST_COOKIE = "fc_guest";
export const CASHIER_COOKIE = "fc_cashier";
const OPERATOR_TTL_MS = 12 * 60 * 60 * 1000;
const CASHIER_TTL_MS = 14 * 60 * 60 * 1000;
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

/**
 * Names the current CASHIER_PASSWORD without revealing it, so changing the
 * password signs every cashier out.
 */
function cashierKeyId(settings: Settings) {
  return createHmac("sha256", signingSecret(settings))
    .update(`cashier-password\n${cashierPassword(settings)}`)
    .digest("base64url")
    .slice(0, 16);
}

/**
 * The cashier role: authorise, stop and mark paid on the console. A cashier
 * cookie never opens the operator pages; an operator may use the console.
 */
export function cashierToken(settings: Settings, now = Date.now()) {
  return signToken(
    signingSecret(settings),
    "cashier",
    `store-${cashierKeyId(settings)}`,
    now + CASHIER_TTL_MS,
  );
}

export async function isCashier(settings: Settings) {
  const jar = await cookies();
  const secret = signingSecret(settings);
  return (
    verifyToken(secret, "cashier", jar.get(CASHIER_COOKIE)?.value) ===
      `store-${cashierKeyId(settings)}` ||
    verifyToken(secret, "operator", jar.get(OPERATOR_COOKIE)?.value) === "site"
  );
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

export const cashierCookie = (settings: Settings) =>
  cookieOptions(CASHIER_TTL_MS, !settings.demo);

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

// Best-effort brute-force brake per server instance and login page (key it by
// role and client); put a WAF rule in front for more.
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

// The public driver screen polls every few seconds; this caps one client at
// 60 reads a minute per instance.
const reads = new Map<string, { count: number; since: number }>();
export function counterAllowed(client: string, now = Date.now()) {
  const entry = reads.get(client);
  if (!entry || now - entry.since > 60 * 1000) {
    reads.set(client, { count: 1, since: now });
    if (reads.size > 5000) reads.delete(reads.keys().next().value!);
    return true;
  }
  entry.count += 1;
  return entry.count <= 60;
}
