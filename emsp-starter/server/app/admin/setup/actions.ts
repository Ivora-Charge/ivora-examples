"use server";

import { currentAdmin } from "@/lib/accounts/admin-session";
import { asAdmin, type AdminResult } from "@/lib/server/admin-action";
import type { SetupStatus } from "@/lib/setup/checks";
import { readSetupStatus } from "@/lib/setup/status";

export type SetupState = AdminResult & { status?: SetupStatus };

const SETTINGS = {
  shown: () => false,
  fallback: "The setup status could not be read.",
  what: "setup status",
};

/**
 * The setup status, for the Setup and Health page and the menu's name for it. A read
 * that changes nothing, so it answers any signed-in admin, read-only ones too, and,
 * while ADMIN_SECRET is set, whoever gives it (the same gate as every admin action).
 * Nobody else gets an answer: a visitor's page has `publicSetupView` at most.
 */
export async function setupStatusAction(
  _prev: SetupState,
  form: FormData,
): Promise<SetupState> {
  const read = async (): Promise<SetupState> => ({
    ok: true,
    status: await readSetupStatus(undefined, { fresh: true }),
  });
  if (await currentAdmin()) {
    try {
      return await read();
    } catch (e) {
      console.error(
        `Admin setup status action failed: ${e instanceof Error ? e.name : "unknown error"}`,
      );
      return { ok: false, message: SETTINGS.fallback, code: "unexpected" };
    }
  }
  return asAdmin(form, read, SETTINGS);
}
