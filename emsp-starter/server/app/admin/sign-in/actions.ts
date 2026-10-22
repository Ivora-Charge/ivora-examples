"use server";

import { headers } from "next/headers";
import { clearAdminCookie, setAdminCookie } from "@/lib/accounts/admin-session";
import { accountStore, authProvider } from "@/lib/accounts/registry";
import { requestCode, SignInError, verifyProof } from "@/lib/accounts/sign-in";
import { field } from "@/lib/server/admin-action";
import { clientAddress } from "@/lib/server/rate-limit";

export type SignInState = { ok?: boolean; message?: string; email?: string };

async function client(): Promise<string | null> {
  try {
    return clientAddress(await headers());
  } catch {
    return null;
  }
}

function problem(e: unknown, what: string): SignInState {
  if (e instanceof SignInError) return { ok: false, message: e.message };
  console.error(
    `Admin ${what} failed: ${e instanceof Error ? e.name : "unknown error"}`,
  );
  return { ok: false, message: "Something went wrong. Try again." };
}

/** Emails a sign-in code. The same answer for every valid address. */
export async function requestAdminCodeAction(
  _prev: SignInState,
  form: FormData,
): Promise<SignInState> {
  const email = field(form, "email");
  try {
    await requestCode({ email }, await client(), { auth: authProvider() });
    return {
      ok: true,
      message:
        "If the address can sign in, an email with a code is on its way.",
      email: email.trim().toLowerCase(),
    };
  } catch (e) {
    return problem(e, "sign-in code");
  }
}

/** Signs an admin in: the code must be right and the user in the admin role table. */
export async function verifyAdminCodeAction(
  _prev: SignInState,
  form: FormData,
): Promise<SignInState> {
  try {
    const auth = authProvider();
    const session = await verifyProof(
      { email: field(form, "email"), code: field(form, "code") },
      await client(),
      { auth },
    );
    const role = await accountStore().adminRole(session.user.id);
    if (!role) {
      await auth.signOut(session.accessToken);
      return { ok: false, message: "This account is not an admin." };
    }
    await setAdminCookie(session.accessToken, session.expiresAt);
    return {
      ok: true,
      message: `Signed in as ${session.user.email} (${role === "admin" ? "admin" : "read only"}).`,
    };
  } catch (e) {
    return problem(e, "sign-in");
  }
}

export async function signOutAdminAction(): Promise<SignInState> {
  const token = await clearAdminCookie();
  if (token) await authProvider().signOut(token);
  return { ok: true, message: "Signed out." };
}
