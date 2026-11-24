import "server-only";
import { cache } from "react";
import { currentAdmin } from "@/lib/accounts/admin-session";
import { secretSession } from "@/lib/server/admin-secret-session";

/**
 * Who is signed in, read once per request: the root layout asks on every page (for the
 * shell and the sign-in state), and Setup asks again for its admin-only settings.
 */
export const requestAdmin = cache(currentAdmin);

/**
 * This request's admin-secret session, checked once per request: every check of a
 * cookie that is not a session counts toward the limit on those, so the layout and the
 * sign-in page share one answer.
 */
export const requestSecretState = cache(secretSession);

/** Whether this request has a working admin-secret session. */
export const requestSecretSession = cache(
  async () => (await requestSecretState()) === "ok",
);
