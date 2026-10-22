import "server-only";
import { headers } from "next/headers";
import { currentAdmin } from "@/lib/accounts/admin-session";
import { adminClientKey, adminEnabled, checkAdminSecret } from "./admin";

/** What an admin form shows after an action. */
export type AdminResult = { ok?: boolean; message?: string };

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
 * `fallback`.
 */
export async function asAdmin<T extends AdminResult>(
  form: FormData,
  fn: () => Promise<T>,
  {
    shown,
    fallback,
    what,
  }: { shown: (e: unknown) => boolean; fallback: string; what: string },
): Promise<T | AdminResult> {
  const admin = await currentAdmin();
  if (admin && admin.role !== "admin")
    return { ok: false, message: "Your admin role is read-only." };
  if (!admin) {
    if (!adminEnabled())
      return {
        ok: false,
        message:
          "Admin actions are disabled: sign in as an admin, or set ADMIN_SECRET (at least 32 characters) on the server.",
      };
    const check = checkAdminSecret(
      field(form, "adminSecret"),
      await clientKey(),
    );
    if (check === "limited")
      return {
        ok: false,
        message: "Too many wrong admin secrets. Try again in 15 minutes.",
      };
    if (check !== "ok") return { ok: false, message: "Wrong admin secret." };
  }
  try {
    return await fn();
  } catch (e) {
    if (shown(e) && e instanceof Error)
      return { ok: false, message: e.message };
    if (e instanceof Error && "code" in e && e.code === "demo_mode")
      return { ok: false, message: e.message };
    console.error(
      `Admin ${what} action failed: ${e instanceof Error ? e.name : "unknown error"}`,
    );
    return { ok: false, message: fallback };
  }
}
