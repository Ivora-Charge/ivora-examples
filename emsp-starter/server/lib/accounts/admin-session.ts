import "server-only";
import { cookies } from "next/headers";
import { userOf } from "./api";
import type { AuthProvider } from "./auth";
import { accountStore, authProvider } from "./registry";
import type { AccountStore, AdminRole } from "./store";

/**
 * Admin sign-in for the admin web: the same passwordless Supabase Auth sign-in as
 * drivers, for users listed in the admin role table (`emsp_admins`). The access token
 * is kept in an httpOnly, SameSite=Strict cookie, so page scripts never see it and
 * other sites cannot send it. It lasts as long as the Supabase access token (an hour
 * by default); then the admin signs in again.
 */
export const ADMIN_COOKIE = "emsp_admin";

export type AdminIdentity = { userId: string; email: string; role: AdminRole };

/** The admin behind an access token, or null when it is invalid or not an admin. */
export async function adminFromToken(
  token: string,
  deps: { auth?: AuthProvider; accounts?: AccountStore } = {},
): Promise<AdminIdentity | null> {
  const user = await userOf(token, deps.auth ?? authProvider());
  if (!user) return null;
  const role = await (deps.accounts ?? accountStore()).adminRole(user.id);
  return role ? { userId: user.id, email: user.email, role } : null;
}

/** The signed-in admin of this request, or null (also outside a request). */
export async function currentAdmin(): Promise<AdminIdentity | null> {
  let token: string | undefined;
  try {
    token = (await cookies()).get(ADMIN_COOKIE)?.value;
  } catch {
    return null;
  }
  if (!token) return null;
  try {
    return await adminFromToken(token);
  } catch (e) {
    console.error(
      `Admin session check failed: ${e instanceof Error ? e.name : "unknown error"}`,
    );
    return null;
  }
}

export async function setAdminCookie(token: string, expiresAt: string) {
  (await cookies()).set(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export async function clearAdminCookie(): Promise<string | undefined> {
  const store = await cookies();
  const token = store.get(ADMIN_COOKIE)?.value;
  store.delete(ADMIN_COOKIE);
  return token;
}
