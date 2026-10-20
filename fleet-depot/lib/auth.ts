import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config, isDemo } from "./config";

/**
 * Operator gate. Live mode can send charging profiles to real stations and block
 * RFID cards, so it refuses to run without OPERATOR_PASSWORD. Demo mode is open.
 */

export const SESSION_COOKIE = "fd_session";
export const SESSION_SECONDS = 12 * 3600;

export type Gate =
  | { mode: "open" }
  | { mode: "missing"; reason: string }
  | { mode: "password"; password: string };

export function gate(): Gate {
  if (isDemo()) return { mode: "open" };
  const password = config.operatorPassword;
  if (!password)
    return {
      mode: "missing",
      reason:
        "Live mode needs OPERATOR_PASSWORD. Set it in the environment and restart.",
    };
  return { mode: "password", password };
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time password check (hashing first makes the lengths equal). */
export function checkPassword(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

// Changing the password invalidates every session.
const signingKey = (password: string) =>
  createHmac("sha256", password).update("fleet-depot session v1").digest();

export function issueToken(
  password: string,
  nowMs = Date.now(),
  ttlSeconds = SESSION_SECONDS,
): string {
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const mac = createHmac("sha256", signingKey(password))
    .update(String(exp))
    .digest("base64url");
  return `${exp}.${mac}`;
}

export function verifyToken(
  token: string | undefined,
  password: string,
  nowMs = Date.now(),
): boolean {
  if (!token) return false;
  const [exp, mac] = token.split(".");
  if (!exp || !mac || !/^\d+$/.test(exp)) return false;
  if (Number(exp) * 1000 <= nowMs) return false;
  const want = createHmac("sha256", signingKey(password)).update(exp).digest();
  const got = Buffer.from(mac, "base64url");
  return got.length === want.length && timingSafeEqual(got, want);
}

function cookieValue(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name)
      return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** Writes must come from this app's own pages: Origin (or Sec-Fetch-Site) must match. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") === "same-origin";
  const host =
    req.headers.get("x-forwarded-host") ??
    req.headers.get("host") ??
    new URL(req.url).host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function isSignedIn(token: string | undefined): boolean {
  const g = gate();
  if (g.mode === "open") return true;
  if (g.mode === "missing") return false;
  return verifyToken(token, g.password);
}

/** Returns an error response, or null when the request may proceed. */
export function guard(req: Request, opts: { write: boolean }): Response | null {
  const g = gate();
  if (g.mode === "missing")
    return Response.json(
      { error: g.reason, code: "operator_password_missing" },
      { status: 503 },
    );
  if (opts.write && !sameOrigin(req))
    return Response.json(
      { error: "Cross-origin request refused", code: "cross_origin" },
      { status: 403 },
    );
  if (
    g.mode === "password" &&
    !verifyToken(cookieValue(req, SESSION_COOKIE), g.password)
  )
    return Response.json(
      { error: "Sign in first", code: "unauthorized" },
      { status: 401 },
    );
  return null;
}

// Simple in-process login throttle: 10 failures per minute.
const failures: number[] = [];
export function loginAllowed(nowMs = Date.now()): boolean {
  while (failures.length && failures[0] < nowMs - 60_000) failures.shift();
  return failures.length < 10;
}
export function recordLoginFailure(nowMs = Date.now()) {
  failures.push(nowMs);
}
