"use server";

import { clearAdminCookie, setAdminCookie } from "@/lib/accounts/admin-session";
import { accountStore, authProvider } from "@/lib/accounts/registry";
import {
  requestCode,
  SignInError,
  verifyProof,
  type SignInLimit,
} from "@/lib/accounts/sign-in";
import type { AccountStore } from "@/lib/accounts/store";
import { checkAdminSecret, secretSessionsLimited } from "@/lib/server/admin";
import { field } from "@/lib/server/admin-action";
import {
  dropDeadSecretSession,
  endSecretSession,
  requestClient as client,
  startSecretSession,
} from "@/lib/server/admin-secret-session";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { logText } from "@/lib/server/log-error";

export type SignInState = {
  ok?: boolean;
  message?: string;
  code?: string;
  nextStep?: string;
  /** The address the code was asked for, or the one a link signed in. */
  email?: string;
  /** A limit refused this: whose it is, and for how long. */
  limit?: SignInLimit;
  /** After a code was sent: seconds until another may be asked for this address. */
  resendAfter?: number;
  /**
   * With `not_an_admin` only: true when the admin list is empty, false when it has
   * someone. Never who or how many. Left out in demo mode and when it could not be read.
   */
  noAdmins?: boolean;
};

function problem(e: unknown, what: string): SignInState {
  if (e instanceof SignInError)
    return e.limit
      ? {
          ok: false,
          message: e.message,
          code:
            e.limit.source === "email_service"
              ? "email_service_limited"
              : "sign_in_limited",
          limit: e.limit,
        }
      : { ok: false, message: e.message };
  console.error(`Admin ${what} failed: ${logText(e)}`);
  return { ok: false, message: "Something went wrong. Try again." };
}

/**
 * Emails a sign-in code. The same answer for every valid address. If the email
 * template has a link, it leads back to the sign-in page, which accepts it.
 */
export async function requestAdminCodeAction(
  _prev: SignInState,
  form: FormData,
): Promise<SignInState> {
  const email = field(form, "email");
  await dropDeadSecretSession();
  try {
    const { resendAfter } = await requestCode(
      { email },
      await client(),
      { auth: authProvider() },
      {
        resendCooldown: true,
        redirectTo: `${config.publicBaseUrl}/admin/sign-in`,
      },
    );
    return {
      ok: true,
      message:
        "If the address can sign in, an email with a code is on its way.",
      email: email.trim().toLowerCase(),
      resendAfter,
    };
  } catch (e) {
    return problem(e, "sign-in code");
  }
}

/**
 * Whether the admin list is empty, for someone who just proved an address that is not
 * on it. One row at most is read, and only the yes or no leaves this function.
 */
async function adminListEmpty(
  accounts: AccountStore,
): Promise<boolean | undefined> {
  // Demo mode has no admin list to add anyone to.
  if (isDemo()) return undefined;
  try {
    return !(await accounts.hasAdmin());
  } catch (e) {
    console.error(`Admin list check failed: ${logText(e)}`);
    return undefined;
  }
}

/** Signs an admin in: the proof must be right and the user in the admin role table. */
async function signIn(
  proof: { email: string; code: string } | { tokenHash: string },
): Promise<SignInState> {
  await dropDeadSecretSession();
  try {
    const auth = authProvider();
    const session = await verifyProof(proof, await client(), { auth });
    const accounts = accountStore();
    const role = await accounts.adminRole(session.user.id);
    if (!role) {
      await auth.signOut(session.accessToken);
      const noAdmins = await adminListEmpty(accounts);
      return {
        ok: false,
        message: "This account is not an admin.",
        code: "not_an_admin",
        email: session.user.email,
        ...(noAdmins === undefined ? {} : { noAdmins }),
      };
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

/** Signs in with the code from the email. */
export async function verifyAdminCodeAction(
  _prev: SignInState,
  form: FormData,
): Promise<SignInState> {
  return signIn({ email: field(form, "email"), code: field(form, "code") });
}

/**
 * Signs in with the token hash of the email's link. The sign-in page sends it when its
 * button is pressed, never by itself: opening the link alone signs nobody in.
 */
export async function verifyAdminLinkAction(
  _prev: SignInState,
  form: FormData,
): Promise<SignInState> {
  // An empty token hash would be read as "no link" and the email and code asked for.
  return signIn({ tokenHash: field(form, "tokenHash") || "-" });
}

/**
 * Drops an admin-secret session cookie that does not work (expired, from before
 * ADMIN_SECRET was changed, or not checked because too many failed). The sign-in page
 * calls it when it opens with such a cookie, because a page cannot change cookies while
 * it renders. It checks no secret and answers nothing; a working session is left alone.
 */
export async function dropStaleSecretSessionAction(): Promise<void> {
  await dropDeadSecretSession();
}

/**
 * Exchanges ADMIN_SECRET for an admin-secret session cookie (an hour, httpOnly). The
 * only place that takes the secret, and the only thing its lockout counts: wrong
 * secrets submitted here. On a server without ADMIN_SECRET every value is a wrong one.
 * A cookie that does not work is dropped whatever the answer, while limited too.
 *
 * Session cookies that do not check out have a count of their own, which never stops
 * this exchange; a right secret starts that count afresh for its client. If cookies
 * from other clients have reached the cap in total, no session would be accepted, so
 * none is started and the answer says so.
 */
export async function adminSecretSignInAction(
  _prev: SignInState,
  form: FormData,
): Promise<SignInState> {
  await dropDeadSecretSession();
  const from = await client();
  const check = checkAdminSecret(field(form, "secret"), from);
  if (check === "limited")
    return {
      ok: false,
      message: "Too many wrong admin secrets. Try again in 15 minutes.",
      code: "rate_limited",
      nextStep: "Wait 15 minutes, or sign in by email instead.",
    };
  if (check === "ok" && secretSessionsLimited(from))
    return {
      ok: false,
      message:
        "Admin-secret sessions are paused: too many session cookies did not check out.",
      code: "session_limited",
      nextStep: "Wait 15 minutes, or sign in by email instead.",
    };
  if (check !== "ok" || !(await startSecretSession()))
    return {
      ok: false,
      message: "That is not this server's admin secret.",
      code: "wrong_secret",
      nextStep:
        "Check the value of ADMIN_SECRET in the server's settings, or sign in by email instead.",
    };
  return { ok: true, message: "Signed in with the admin secret." };
}

/** Signs out: ends the email sign-in's session and drops both admin cookies. */
export async function signOutAdminAction(): Promise<SignInState> {
  const token = await clearAdminCookie();
  await endSecretSession();
  if (token) await authProvider().signOut(token);
  return { ok: true, message: "Signed out." };
}
