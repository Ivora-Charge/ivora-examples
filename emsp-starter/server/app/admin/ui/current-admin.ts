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
 * Whether this request has an admin-secret session, checked once per request: a
 * session that does not check out counts as a wrong secret, and should count once.
 */
export const requestSecretSession = cache(
  async () => (await secretSession()) === "ok",
);
