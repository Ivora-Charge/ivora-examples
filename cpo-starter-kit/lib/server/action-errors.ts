import "server-only";
import { unstable_rethrow } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { AccessDeniedError } from "./auth";
import { ChargerError } from "./chargers/types";
import { LiveError } from "./live/types";
import { describeError, IvoraError } from "./ivora";
import { OnboardingError } from "./onboarding/types";
import { PricingError } from "./pricing/types";
import { TeamError } from "./team/types";

/**
 * Turns an error from a server action into a message for the form. Errors staff can
 * act on (TeamError, OnboardingError, ChargerError, LiveError, PricingError, AccessDeniedError) are shown as they are, Ivora
 * API errors with their code and request ID; anything else is logged by name only and
 * shown as a setup problem, never with its details.
 */
export function actionError(e: unknown, what: string): ActionState {
  unstable_rethrow(e); // redirect() from requireRole() and other Next.js signals
  if (e instanceof PricingError)
    return {
      error: e.message,
      problems: e.problems.length ? e.problems : undefined,
    };
  if (
    e instanceof TeamError ||
    e instanceof OnboardingError ||
    e instanceof ChargerError ||
    e instanceof LiveError ||
    e instanceof AccessDeniedError
  )
    return { error: e.message };
  if (e instanceof IvoraError) {
    console.error(
      `cpo-starter-kit: ${what} failed:`,
      `${e.code} (HTTP ${e.status}) ${e.requestId ?? ""}`,
    );
    return { error: describeError(e) };
  }
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
