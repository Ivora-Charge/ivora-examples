import "server-only";
import { createHash } from "node:crypto";
import { config } from "@/lib/server/config";
import { mode } from "@/lib/server/demo";
import type { AuthProvider, AuthUser } from "./auth";
import { accountStore, authProvider } from "./registry";
import type { AccountStore, Driver } from "./store";

/**
 * The driver API's plumbing: CORS for the app's web build, JSON answers, and the
 * signed-in driver.
 *
 * The app sends `Authorization: Bearer <access token>` from its sign-in; no cookies, so
 * a page on another origin cannot ride on a driver's session. Browsers may read the
 * answers only from APP_ORIGINS (native apps send no Origin and need none).
 */
const NO_STORE = { "Cache-Control": "no-store" };

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  return origin && config.appOrigins.includes(origin)
    ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
    : { Vary: "Origin" };
}

export function json(
  request: Request,
  body: unknown,
  status = 200,
  extra = {},
) {
  return Response.json(body, {
    status,
    headers: { ...NO_STORE, ...corsHeaders(request), ...extra },
  });
}

/** The answer to a CORS preflight of a driver endpoint. */
export function preflight(request: Request, methods: string) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request),
      "Access-Control-Allow-Methods": `${methods}, OPTIONS`,
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
    },
  });
}

/** The request's JSON object body, or null when it is not one (at most 16 KB). */
export async function body(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 16_384) return null;
  try {
    const text = await request.text();
    if (text.length > 16_384) return null;
    const v: unknown = text ? JSON.parse(text) : {};
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** How long a checked access token is trusted before Supabase Auth is asked again. */
const USER_CACHE_MS = 30_000;
const USER_CACHE_MAX = 10_000;
const holder = globalThis as unknown as {
  __emspUserCache?: Map<string, { user: AuthUser; until: number }>;
};
const cache = () => (holder.__emspUserCache ??= new Map());
const tokenKey = (t: string) =>
  createHash("sha256").update(t).digest("base64url");

export function bearer(request: Request): string | null {
  const m = /^Bearer ([\x21-\x7e]{16,4096})$/.exec(
    request.headers.get("authorization") ?? "",
  );
  return m ? m[1] : null;
}

/** The user of an access token, cached for a short while. */
export async function userOf(
  token: string,
  auth: AuthProvider = authProvider(),
  now = Date.now(),
): Promise<AuthUser | null> {
  const key = tokenKey(token);
  const held = cache().get(key);
  if (held && held.until > now) return held.user;
  const user = await auth.getUser(token);
  if (!user) {
    cache().delete(key);
    return null;
  }
  if (cache().size >= USER_CACHE_MAX)
    for (const [k, v] of cache()) if (v.until <= now) cache().delete(k);
  if (cache().size >= USER_CACHE_MAX) cache().clear();
  cache().set(key, { user, until: now + USER_CACHE_MS });
  return user;
}

/** Forgets a token, at sign-out. */
export function forgetToken(token: string) {
  cache().delete(tokenKey(token));
}

export function clearUserCacheForTests() {
  cache().clear();
}

/**
 * Runs `fn` for the signed-in driver, or answers 401. A user without an account (one
 * that signed in to the admin web only, say) is not a driver.
 */
export async function withDriver(
  request: Request,
  fn: (driver: Driver) => Promise<Response>,
  deps: { auth?: AuthProvider; accounts?: AccountStore } = {},
): Promise<Response> {
  const token = bearer(request);
  const user = token ? await userOf(token, deps.auth) : null;
  const driver = user
    ? await (deps.accounts ?? accountStore()).getDriver(user.id)
    : null;
  if (!driver)
    return json(request, { error: "Sign in again." }, 401, {
      "WWW-Authenticate": "Bearer",
    });
  return fn(driver);
}

/** What the app shows of an account. */
export function driverView(d: Driver) {
  return {
    id: d.id,
    email: d.email,
    status: d.status,
    hasCard: d.defaultPaymentMethodId !== null,
    mode: mode(),
  };
}

/** Logs an unexpected error by name only and answers 500. */
export function failed(request: Request, what: string, e: unknown) {
  console.error(
    `Driver API ${what} failed: ${e instanceof Error ? e.name : "unknown error"}`,
  );
  return json(request, { error: "Something went wrong" }, 500);
}
