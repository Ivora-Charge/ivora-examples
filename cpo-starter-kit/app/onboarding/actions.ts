"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { checkBrandColor, describeBrandCheck } from "@/lib/brand-colors";
import { actionError } from "@/lib/server/action-errors";
import { requireRole } from "@/lib/server/auth";
import { isDemo } from "@/lib/server/env";
import {
  DEMO_STRIPE_STATES,
  type DemoStripeState,
} from "@/lib/server/ivora/demo";
import {
  getOnboarding,
  OnboardingError,
  saveBrand,
  saveCompany,
  syncBranding,
  type SyncResult,
} from "@/lib/server/onboarding";
import { resetDemoOnboarding } from "@/lib/server/onboarding/demo-cookie";
import { LOGO_MAX_BYTES } from "@/lib/server/onboarding/image";

// Owners and managers only: every action checks the signed-in staff member's role on
// the server first (requireRole), the onboarding service checks it again, and the
// database checks it in the same statement as the write.

const str = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : undefined;
};

const demoNote = () => (isDemo() ? " Demo: nothing was sent to Ivora." : "");

function syncWarning(sync: SyncResult): string | undefined {
  if (sync.state !== "failed") return undefined;
  return `Saved in the kit, but Ivora's driver payment pages were not updated: ${sync.error} Use "Push to Ivora again" when it is fixed.`;
}

export async function saveCompanyAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireRole("manager");
    const { sync } = await saveCompany(getOnboarding(), actor, {
      name: str(form, "name"),
      supportEmail: str(form, "supportEmail"),
      supportUrl: str(form, "supportUrl"),
      website: str(form, "website"),
      timeZone: str(form, "timeZone"),
      currency: str(form, "currency"),
    });
    revalidatePath("/", "layout");
    return {
      ok:
        sync.state === "synced"
          ? `Company details saved, and the name and support contacts are on your driver payment pages.${demoNote()}`
          : "Company details saved.",
      warning: syncWarning(sync),
    };
  } catch (e) {
    return actionError(e, "company save");
  }
}

export async function saveBrandAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireRole("manager");
    const file = form.get("logo");
    let logo: Uint8Array | null = null;
    if (file instanceof File && file.size > 0) {
      if (file.size > LOGO_MAX_BYTES)
        throw new OnboardingError(
          "logo_invalid",
          "The logo is larger than 512 KB. Export a smaller image.",
        );
      logo = new Uint8Array(await file.arrayBuffer());
    }
    const color = str(form, "primaryColor");
    const r = await saveBrand(getOnboarding(), actor, {
      primaryColor: color,
      logo,
    });
    revalidatePath("/", "layout");
    const parts = [
      r.sync.state === "synced"
        ? "Brand saved and on your driver payment pages."
        : "Brand saved.",
    ];
    if (r.logo?.state === "uploaded") parts.push("Logo uploaded.");
    if (r.logo?.state === "demo")
      parts.push("Demo: the logo passed the checks but was not uploaded.");
    else if (isDemo()) parts.push("Demo: nothing was sent to Ivora.");
    let check = "";
    try {
      if (color)
        check = ` In this app: ${describeBrandCheck(checkBrandColor(color))}`;
    } catch {
      // Cleared or invalid colour: saveBrand already said so.
    }
    return {
      ok: parts.join(" ") + check,
      warning:
        syncWarning(r.sync) ??
        (r.logo?.state === "failed"
          ? `The brand was saved, but the logo was not uploaded: ${r.logo.error}`
          : undefined),
    };
  } catch (e) {
    return actionError(e, "brand save");
  }
}

/** Pushes the saved branding again, for example after a failed push. */
export async function pushBrandingAction(
  _prev: ActionState,
  _form: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireRole("manager");
    const sync = await syncBranding(getOnboarding(), actor, { force: true });
    revalidatePath("/", "layout");
    if (sync.state === "skipped")
      return { error: "Save your company details first." };
    if (sync.state === "failed") return { error: sync.error };
    return {
      ok: `Your driver payment pages show the saved branding.${demoNote()}`,
    };
  } catch (e) {
    return actionError(e, "branding push");
  }
}

/** Reads the Stripe status again (after connecting it in the Ivora dashboard). */
export async function refreshStripeAction(): Promise<void> {
  await requireRole("manager");
  revalidatePath("/", "layout");
}

/** Demo only: show the Stripe status the visitor picks. */
export async function simulateStripeAction(form: FormData): Promise<void> {
  if (!isDemo()) return;
  await requireRole("manager");
  const state = str(form, "state");
  if (!DEMO_STRIPE_STATES.includes(state as DemoStripeState)) return;
  await getOnboarding().store.setDemoStripe?.(state as DemoStripeState);
  revalidatePath("/", "layout");
}

/** Demo only: back to an empty company. */
export async function resetDemoOnboardingAction(): Promise<void> {
  if (!isDemo()) return;
  await requireRole("manager");
  await resetDemoOnboarding();
  revalidatePath("/", "layout");
}
