import "server-only";
import { headers } from "next/headers";
import { adminClientKey, adminEnabled, checkAdminSecret } from "./admin";

/** What an admin form shows after an action. */
export type AdminResult = { ok?: boolean; message?: string };

export const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

/** Who is asking, for the admin-secret rate limit (see adminClientKey). */
async function clientKey(): Promise<string> {
  try {
    return adminClientKey(await headers());
  } catch {
    // Outside a request (tests): one shared key.
    return "unknown";
  }
}

/**
 * Runs `fn` only for an admin (the temporary ADMIN_SECRET gate, rate limited). Errors
 * become a message for the form: errors `shown` accepts and demo-mode refusals carry
 * their own text, which never includes a token; anything else gets `fallback`.
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
  if (!adminEnabled())
    return {
      ok: false,
      message:
        "Admin actions are disabled: set ADMIN_SECRET (at least 32 characters) on the server.",
    };
  const check = checkAdminSecret(field(form, "adminSecret"), await clientKey());
  if (check === "limited")
    return {
      ok: false,
      message: "Too many wrong admin secrets. Try again in 15 minutes.",
    };
  if (check !== "ok") return { ok: false, message: "Wrong admin secret." };
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
