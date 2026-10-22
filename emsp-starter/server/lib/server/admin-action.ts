import "server-only";
import { headers } from "next/headers";
import { currentAdmin } from "@/lib/accounts/admin-session";
import { explain, explainMessage, UNEXPECTED } from "@/lib/admin/errors";
import { adminClientKey, adminEnabled, checkAdminSecret } from "./admin";

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

/** Who is asking, for the admin-secret rate limit (see adminClientKey). */
async function clientKey(): Promise<string | null> {
  try {
    return adminClientKey(await headers());
  } catch {
    // Outside a request (tests): no per-client key.
    return null;
  }
}

/**
 * Runs `fn` only for an admin: one signed in (Supabase Auth, listed in `emsp_admins`
 * with the role `admin`), or, while ADMIN_SECRET is set, anyone who gives it (rate
 * limited). Errors become a message for the form: errors `shown` accepts and demo-mode
 * refusals carry their own text, which never includes a token; anything else gets
 * `fallback`. Every failure gets a code and a next step. `fn` gets the actor for the
 * audit log: `admin:<user ID>`, or `admin:secret` for the ADMIN_SECRET.
 */
export async function asAdmin<T extends AdminResult>(
  form: FormData,
  fn: (actor: string) => Promise<T>,
  {
    shown,
    fallback,
    what,
  }: { shown: (e: unknown) => boolean; fallback: string; what: string },
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
    if (!adminEnabled())
      return {
        ok: false,
        message:
          "Admin actions are disabled: sign in as an admin, or set ADMIN_SECRET (at least 32 characters) on the server.",
        code: "admin_disabled",
        nextStep: "Sign in as an admin (Sign in, above).",
      };
    const check = checkAdminSecret(
      field(form, "adminSecret"),
      await clientKey(),
    );
    if (check === "limited")
      return {
        ok: false,
        message: "Too many wrong admin secrets. Try again in 15 minutes.",
        code: "rate_limited",
        nextStep: "Wait 15 minutes, or sign in as an admin instead.",
      };
    if (check !== "ok")
      return {
        ok: false,
        message: "Wrong admin secret.",
        code: "wrong_secret",
        nextStep:
          "Enter the server's ADMIN_SECRET, or leave it empty and sign in as an admin.",
      };
  }
  try {
    // Who acted, for the audit log: the signed-in admin's user ID, never an email.
    const result = await fn(admin ? `admin:${admin.userId}` : "admin:secret");
    // A refusal of the action itself (a bad field, an unknown ID) explains itself too.
    if (result.ok === false && !result.code && result.message)
      return { ...result, ...explainMessage(result.message) };
    return result;
  } catch (e) {
    if (
      e instanceof Error &&
      (shown(e) || ("code" in e && e.code === "demo_mode"))
    )
      return { ok: false, message: e.message, ...explain(e) };
    console.error(
      `Admin ${what} action failed: ${e instanceof Error ? e.name : "unknown error"}`,
    );
    return { ok: false, message: fallback, ...UNEXPECTED };
  }
}
