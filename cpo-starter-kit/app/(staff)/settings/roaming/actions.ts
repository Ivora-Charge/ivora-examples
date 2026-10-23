"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { actionError } from "@/lib/server/action-errors";
import { requireRole } from "@/lib/server/auth";
import { isDemo } from "@/lib/server/env";
import { resetDemoOcpi } from "@/lib/server/ivora/demo-ocpi-cookie";
import {
  decideDemoParty,
  getRoaming,
  partyLabel,
  saveRoaming,
} from "@/lib/server/roaming";

// Owners and managers only: every action checks the signed-in staff member's role on
// the server first (requireRole), and the roaming service checks it again. Ivora
// checks the API key's own permission (stations:write) on the write.

const str = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : undefined;
};
const all = (form: FormData, name: string) =>
  form.getAll(name).filter((v): v is string => typeof v === "string");

/** Saves every roaming setting (PUT /ocpi replaces the whole object). */
export async function saveRoamingAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireRole("manager");
    const { settings, partyRequested } = await saveRoaming(
      getRoaming(),
      actor,
      {
        publish: str(form, "publish"),
        displayName: str(form, "displayName"),
        website: str(form, "website"),
        timeZone: str(form, "timeZone"),
        countryCode: str(form, "countryCode"),
        partyId: str(form, "partyId"),
        revision: str(form, "revision"),
        shownLocations: all(form, "shownLocation"),
        publishedLocations: all(form, "publishLocation"),
      },
    );
    revalidatePath("/settings/roaming");
    const demo = isDemo() ? " Demo: nothing was sent to Ivora." : "";
    return {
      ok: `Roaming settings saved.${demo}`,
      warning:
        partyRequested && settings.own_party
          ? `Party ${partyLabel(settings.own_party)} is waiting for Ivora's approval. Until then partners see your locations under Ivora's shared party ${partyLabel(settings.party)}, with your operator name.`
          : undefined,
    };
  } catch (e) {
    return actionError(e, "roaming settings");
  }
}

/** Demo only: plays Ivora staff deciding on the requested party ID. */
export async function demoDecidePartyAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireRole("manager");
    const decision = str(form, "decision") === "reject" ? "reject" : "approve";
    await decideDemoParty(getRoaming(), actor, decision);
    revalidatePath("/settings/roaming");
    return {
      ok:
        decision === "approve"
          ? "Demo: Ivora approved the party ID."
          : "Demo: Ivora rejected the party ID.",
    };
  } catch (e) {
    return actionError(e, "demo party decision");
  }
}

/** Demo only: back to the defaults. */
export async function resetDemoRoamingAction(): Promise<void> {
  if (!isDemo()) return;
  await requireRole("manager");
  await resetDemoOcpi();
  revalidatePath("/settings/roaming");
}
