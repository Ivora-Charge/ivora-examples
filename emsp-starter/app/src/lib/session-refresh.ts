import { ApiError } from "./api";
import type { AuthSession } from "./types";

/** Refresh this long before the access token expires. */
export const REFRESH_LEAD_MS = 60_000;
/** The first retry after a failed refresh; it doubles up to `RETRY_MAX_MS`. */
export const RETRY_FIRST_MS = 15_000;
export const RETRY_MAX_MS = 5 * 60_000;

/**
 * Whether the server turned the refresh token down (400 or 401: unknown, used or
 * expired), so the driver has to sign in again. Anything else (offline, a rate limit,
 * a server error) leaves the session as it is, to be tried again.
 */
export const isRejected = (e: unknown) =>
  e instanceof ApiError && (e.code === "invalid" || e.code === "unauthorized");

/** Milliseconds until the session should be refreshed; 0 when that is now. */
export const refreshIn = (session: AuthSession, now = Date.now()) =>
  Math.max(0, Date.parse(session.expiresAt) - REFRESH_LEAD_MS - now);

/** The wait before retry number `attempt` (0 is the first). */
export const retryIn = (attempt: number) =>
  Math.min(RETRY_FIRST_MS * 2 ** attempt, RETRY_MAX_MS);

/**
 * Keeps one session fresh while the app is open: refreshes it shortly before the access
 * token expires (at once when it already has), and on a network or server error tries
 * again with a growing wait. Calls `onRefreshed` with the new session, after which the
 * caller starts a keeper for that one, or `onRejected` when the driver must sign in
 * again. Returns a function that stops it; a refresh still on its way is then ignored.
 */
export function keepSessionFresh(
  session: AuthSession,
  deps: {
    refresh: (refreshToken: string) => Promise<AuthSession>;
    onRefreshed: (next: AuthSession) => void;
    onRejected: () => void;
    now?: () => number;
  },
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const at = (ms: number, run: () => void) => {
    timer = setTimeout(run, ms);
  };
  const attempt = (n: number) => {
    deps.refresh(session.refreshToken).then(
      (next) => {
        if (!stopped) deps.onRefreshed(next);
      },
      (e: unknown) => {
        if (stopped) return;
        if (isRejected(e)) deps.onRejected();
        else at(retryIn(n), () => attempt(n + 1));
      },
    );
  };
  at(refreshIn(session, deps.now?.() ?? Date.now()), () => attempt(0));
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
