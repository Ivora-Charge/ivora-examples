import { ADMIN_SECRET_COOKIE, issueSecretSession } from "@/lib/server/admin";

/**
 * What `next/headers` answers in tests: the request's cookies and headers, which a test
 * sets and reads here. Use it as the mock of a test file:
 *
 *   vi.mock("next/headers", async () => (await import("./support/request")).nextHeaders);
 */
export const requestCookies = new Map<string, string>();
/** The options each cookie was last set with (its flags and expiry). */
export const cookieOptions = new Map<string, Record<string, unknown>>();
export const requestHeaders = new Headers();

export const nextHeaders = {
  cookies: async () => ({
    get: (name: string) =>
      requestCookies.has(name)
        ? { name, value: requestCookies.get(name) }
        : undefined,
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      requestCookies.set(name, value);
      cookieOptions.set(name, options ?? {});
    },
    delete: (name: string) => {
      requestCookies.delete(name);
      cookieOptions.delete(name);
    },
  }),
  headers: async () => requestHeaders,
};

/** A new request: no cookies, no headers. */
export function resetRequest() {
  requestCookies.clear();
  cookieOptions.clear();
  for (const name of [...requestHeaders.keys()]) requestHeaders.delete(name);
}

/**
 * Gives the request the admin-secret session that the sign-in page hands out for the
 * ADMIN_SECRET set in the environment right now.
 */
export function signInWithSecret(now?: number) {
  const session = issueSecretSession(now);
  if (!session) throw new Error("Set ADMIN_SECRET before signInWithSecret()");
  requestCookies.set(ADMIN_SECRET_COOKIE, session.value);
}
