import "server-only";
import { unstable_rethrow } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { AccessDeniedError } from "./auth";
import { TeamError } from "./team/types";

/**
 * Turns an error from a server action into a message for the form. Errors staff can
 * act on (TeamError, AccessDeniedError) are shown as they are; anything else is logged
 * by name only and shown as a setup problem, never with its details.
 */
export function actionError(e: unknown, what: string): ActionState {
  unstable_rethrow(e); // redirect() from requireRole() and other Next.js signals
  if (e instanceof TeamError || e instanceof AccessDeniedError)
    return { error: e.message };
  console.error(`cpo-starter-kit: ${what} failed:`, {
    error: e instanceof Error ? e.name : "error",
    code:
      e && typeof e === "object" && "code" in e ? String(e.code) : undefined,
  });
  return {
    error:
      "Something went wrong on the server. If you run this deployment, check the Supabase keys and that the migrations ran (see the README).",
  };
}
