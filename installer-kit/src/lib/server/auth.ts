import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isDemo } from "./config";
import { HttpError } from "./errors";

type Env = Record<string, string | undefined>;

export const SESSION_COOKIE = "installer_kit_operator";
export const SESSION_SECONDS = 12 * 60 * 60;
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Live mode can create stations and start chargers, so it only runs behind an
 * operator password. Demo mode is open unless a password is set.
 */
export type Gate =
  | { mode: "open" }
  | { mode: "password"; password: string }
  | { mode: "missing"; reason: string };

export function gate(env: Env = process.env): Gate {
  const password = env.OPERATOR_PASSWORD ?? "";
  if (password.length >= MIN_PASSWORD_LENGTH)
    return { mode: "password", password };
  if (password)
    return {
      mode: "missing",
      reason: `OPERATOR_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  if (isDemo(env)) return { mode: "open" };
  return {
    mode: "missing",
    reason:
      "Live mode needs OPERATOR_PASSWORD (at least 12 characters) so only your team can control chargers.",
  };
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time password check (hashing first makes lengths equal). */
export function checkPassword(input: string, password: string): boolean {
  return timingSafeEqual(digest(input), digest(password));
}

function signingKey(password: string) {
  return createHash("sha256")
    .update(`installer-kit operator session\0${password}`)
    .digest();
}

/** `<expiry unix seconds>.<hex HMAC>`; changing the password ends every session. */
export function issueToken(password: string, nowMs = Date.now()): string {
  const expires = String(Math.floor(nowMs / 1000) + SESSION_SECONDS);
  const mac = createHmac("sha256", signingKey(password))
    .update(`operator:${expires}`)
    .digest("hex");
  return `${expires}.${mac}`;
}

export function verifyToken(
  token: string | undefined,
  password: string,
  nowMs = Date.now(),
): boolean {
  const match = /^(\d{1,12})\.([a-f0-9]{64})$/.exec(token ?? "");
  if (!match) return false;
  const expected = createHmac("sha256", signingKey(password))
    .update(`operator:${match[1]}`)
    .digest("hex");
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(match[2])))
    return false;
  return Number(match[1]) > nowMs / 1000;
}

/** True when the operator may use the app with this session cookie. */
export function authorized(token: string | undefined, env: Env = process.env) {
  const g = gate(env);
  if (g.mode === "open") return true;
  if (g.mode === "missing") return false;
  return verifyToken(token, g.password);
}

/**
 * Browsers send Origin on every POST; refuse writes from other sites so a
 * page elsewhere cannot drive this app with the operator's cookie.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === (host ?? new URL(req.url).host);
  } catch {
    return false;
  }
}

function cookieValue(req: Request, name: string) {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name)
      return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** Guard for every operator route. Writes also need a same-origin request. */
export function requireOperator(req: Request, opts: { write: boolean }) {
  const g = gate();
  if (g.mode === "missing")
    throw new HttpError(503, "operator_password_missing", g.reason);
  if (opts.write && !sameOrigin(req))
    throw new HttpError(
      403,
      "cross_origin",
      "This request must come from the installer kit itself.",
    );
  if (
    g.mode === "password" &&
    !verifyToken(cookieValue(req, SESSION_COOKIE), g.password)
  )
    throw new HttpError(
      401,
      "sign_in_required",
      "Sign in with the operator password.",
    );
}

/** Slows down password guessing: at most 5 failures per minute per instance. */
const failures: number[] = [];
export function loginAllowed(nowMs = Date.now()) {
  while (failures.length && failures[0] < nowMs - 60_000) failures.shift();
  return failures.length < 5;
}
export function recordLoginFailure(nowMs = Date.now()) {
  failures.push(nowMs);
}
