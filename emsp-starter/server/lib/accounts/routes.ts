import "server-only";
import { peerStore } from "@/lib/ocpi/registry";
import { clientAddress } from "@/lib/server/rate-limit";
import { tokenStore } from "@/lib/tokens/registry";
import {
  bearer,
  body,
  corsHeaders,
  driverView,
  failed,
  forgetToken,
  json,
  withDriver,
} from "./api";
import { accountStore, authProvider } from "./registry";
import {
  refresh,
  requestCode,
  SignInError,
  verify,
  type SignInDeps,
} from "./sign-in";
import type { AuthSession } from "./auth";

/**
 * The driver API's sign-in endpoints, for the app (native and web) and any web client:
 *
 *   POST /api/v1/auth/code       { email }                 -> 202, an email is on its way
 *   POST /api/v1/auth/verify     { email, code } | { tokenHash } -> session and account
 *   POST /api/v1/auth/refresh    { refreshToken }          -> a new session
 *   POST /api/v1/auth/sign-out   (Bearer)                  -> 204
 *   GET  /api/v1/me              (Bearer)                  -> the account
 */
const deps = (): SignInDeps => ({
  auth: authProvider(),
  accounts: accountStore(),
  tokens: tokenStore(),
  peers: peerStore(),
});

const sessionView = (s: AuthSession) => ({
  accessToken: s.accessToken,
  refreshToken: s.refreshToken,
  expiresAt: s.expiresAt,
});

function signInError(request: Request, e: unknown, what: string) {
  if (e instanceof SignInError)
    return json(
      request,
      { error: e.message },
      e.httpStatus,
      e.retryAfter ? { "Retry-After": String(e.retryAfter) } : {},
    );
  return failed(request, what, e);
}

export async function codeRoute(request: Request) {
  const input = await body(request);
  if (!input) return json(request, { error: "Send a JSON object." }, 400);
  try {
    await requestCode(
      { email: input.email },
      clientAddress(request.headers),
      deps(),
    );
    return json(
      request,
      {
        message:
          "If the address can sign in, an email with a code is on its way.",
      },
      202,
    );
  } catch (e) {
    return signInError(request, e, "sign-in code");
  }
}

export async function verifyRoute(request: Request) {
  const input = await body(request);
  if (!input) return json(request, { error: "Send a JSON object." }, 400);
  try {
    const { session, driver } = await verify(
      input,
      clientAddress(request.headers),
      deps(),
    );
    return json(request, {
      session: sessionView(session),
      driver: driverView(driver),
    });
  } catch (e) {
    return signInError(request, e, "sign-in");
  }
}

export async function refreshRoute(request: Request) {
  const input = await body(request);
  if (!input) return json(request, { error: "Send a JSON object." }, 400);
  try {
    return json(request, {
      session: sessionView(await refresh(input, deps())),
    });
  } catch (e) {
    return signInError(request, e, "session refresh");
  }
}

export async function signOutRoute(request: Request) {
  const token = bearer(request);
  if (token) {
    forgetToken(token);
    await authProvider().signOut(token);
  }
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store", ...corsHeaders(request) },
  });
}

export function meRoute(request: Request) {
  return withDriver(request, async (driver) =>
    json(request, { driver: driverView(driver) }),
  );
}
