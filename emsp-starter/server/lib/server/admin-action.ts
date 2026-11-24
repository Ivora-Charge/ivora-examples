import "server-only";
import { currentAdmin } from "@/lib/accounts/admin-session";
import {
  explain,
  explainMessage,
  UNEXPECTED,
  type TokenContext,
} from "@/lib/admin/errors";
import { logText } from "@/lib/server/log-error";
import { adminEnabled } from "./admin";
import { dropDeadSecretSession, secretSession } from "./admin-secret-session";

/**
 * What an admin form shows after an action. A failed one also has a code (the OCPI
 * status code when a CPO gave one) and a next step (lib/admin/errors.ts).
 */
export type AdminResult = {
  ok?: boolean;
  message?: string;
  code?: string;
  nextStep?: string;
};

export const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

/** What the gate answers when the admin secret is set and no admin is signed in. */
const SIGNED_OUT = {
  ok: false,
  message: "Sign in as an admin.",
  code: "signed_out",
  nextStep: "Sign in (Account), then try again.",
};
const REFUSED = {
  none: SIGNED_OUT,
  wrong: SIGNED_OUT,
  limited: {
    ok: false,
    message:
      "Admin-secret sessions are paused: too many session cookies did not check out.",
    code: "session_limited",
    nextStep:
      "Sign in again with the admin secret (Account), or wait 15 minutes.",
  },
  expired: {
    ok: false,
    message: "The admin-secret session has ended.",
    code: "session_expired",
    nextStep: "Sign in again (Account). The session lasts an hour.",
  },
} satisfies Record<string, AdminResult>;

/**
 * Runs `fn` only for an admin: one signed in (Supabase Auth, listed in `emsp_admins`
 * with the role `admin`), or, while ADMIN_SECRET is set, one with an admin-secret
 * session from the sign-in page (lib/server/admin-secret-session.ts). The secret itself
 * is taken on the sign-in page only: no field of `form` is read here. Errors become a
 * message for the form: errors `shown` accepts and demo-mode refusals carry their own
 * text, which never includes a token; anything else gets `fallback`. Every failure gets
 * a code and a next step. `fn` gets the actor for the audit log: `admin:<user ID>`, or
 * `admin:secret` for an admin-secret session.
 */
export async function asAdmin<T extends AdminResult>(
  _form: FormData,
  fn: (actor: string) => Promise<T>,
  {
    shown,
    fallback,
    what,
    token,
  }: {
    shown: (e: unknown) => boolean;
    fallback: string;
    what: string;
    /** Which token a refusal by a CPO is about (lib/admin/errors.ts). */
    token?: TokenContext;
  },
): Promise<T | AdminResult> {
  const admin = await currentAdmin();
  if (admin && admin.role !== "admin")
    return {
      ok: false,
      message: "Your admin role is read-only.",
      code: "read_only",
      nextStep:
        "Ask an admin to give your user the admin role in emsp_admins (README: Admin web).",
    };
  if (!admin) {
    if (!adminEnabled()) {
      await dropDeadSecretSession();
      return {
        ok: false,
        message:
          "Admin actions are disabled: sign in as an admin, or set ADMIN_SECRET (at least 32 characters) on the server.",
        code: "admin_disabled",
        nextStep: "Sign in as an admin (Sign in, above).",
      };
    }
    const session = await secretSession();
    if (session !== "ok") {
      // A cookie that does not work is dropped here, where the answer can still
      // change cookies. It was checked once, above, and is not checked again.
      await dropDeadSecretSession(session);
      return REFUSED[session];
    }
  }
  try {
    // Who acted, for the audit log: the signed-in admin's user ID, never an email.
    const result = await fn(admin ? `admin:${admin.userId}` : "admin:secret");
    // A refusal of the action itself (a bad field, an unknown ID) explains itself too.
    if (result.ok === false && !result.code && result.message)
      return { ...result, ...explainMessage(result.message, token) };
    return result;
  } catch (e) {
    if (
      e instanceof Error &&
      (shown(e) || ("code" in e && e.code === "demo_mode"))
    )
      return { ok: false, message: e.message, ...explain(e, token) };
    console.error(`Admin ${what} action failed: ${logText(e)}`);
    return { ok: false, message: fallback, ...UNEXPECTED };
  }
}
