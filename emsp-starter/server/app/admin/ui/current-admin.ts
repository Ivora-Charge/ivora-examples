import "server-only";
import { cache } from "react";
import { currentAdmin } from "@/lib/accounts/admin-session";

/**
 * Who is signed in, read once per request: the root layout asks on every page (for the
 * shell and the sign-in state), and Setup asks again for its admin-only settings.
 */
export const requestAdmin = cache(currentAdmin);
