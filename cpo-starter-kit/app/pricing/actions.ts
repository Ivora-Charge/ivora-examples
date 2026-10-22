"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { actionError } from "@/lib/server/action-errors";
import { requireRole } from "@/lib/server/auth";
import { isDemo } from "@/lib/server/env";
import {
  discardPendingVersion,
  getPricing,
  previewTariff,
  publishTariff,
  saveTariff,
  setStationPricing,
  type PublishResult,
} from "@/lib/server/pricing";
import { resetDemoPricing } from "@/lib/server/pricing/demo-cookie";
import type { SimulationForm, TariffForm } from "@/lib/server/pricing/input";
import { MAX_PERIODS } from "@/lib/server/pricing/tariff";

// Owners and managers only: every action checks the signed-in staff member's role on
// the server first (requireRole), the pricing service checks it again, and the
// database checks it in the same statement as the write. Changing prices is owner-
// and manager-only because it decides what drivers pay.

const str = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : undefined;
};

const demoNote = () => (isDemo() ? " Demo: nothing was sent to Ivora." : "");

function tariffForm(form: FormData): TariffForm {
  const periods: NonNullable<TariffForm["periods"]> = [];
  for (let i = 0; i < MAX_PERIODS + 1; i++) {
    const start = str(form, `periods.${i}.start`);
    if (start === undefined) continue;
    periods.push({
      start,
      end: str(form, `periods.${i}.end`),
      price: str(form, `periods.${i}.price`),
      days: form
        .getAll(`periods.${i}.days`)
        .filter((d): d is string => typeof d === "string"),
    });
  }
  return {
    name: str(form, "name"),
    kind: str(form, "kind"),
    timeZone: str(form, "timeZone"),
    energy: str(form, "energy"),
    sessionFee: str(form, "sessionFee"),
    idleFee: str(form, "idleFee"),
    idleGrace: str(form, "idleGrace"),
    driverText: str(form, "driverText"),
    driverTextConfirmed: str(form, "driverTextConfirmed"),
    revision: str(form, "revision"),
    periods,
  };
}

const simulationForm = (form: FormData): SimulationForm => ({
  date: str(form, "sim.date"),
  start: str(form, "sim.start"),
  end: str(form, "sim.end"),
  energyKwh: str(form, "sim.energyKwh"),
  idleMinutes: str(form, "sim.idleMinutes"),
});

/** Prices the preview session under the editor's draft (Ivora's simulation). */
export async function previewTariffAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireRole("manager");
    const quote = await previewTariff(
      getPricing(),
      actor,
      tariffForm(form),
      simulationForm(form),
      str(form, "tariffId") || null,
    );
    return {
      ok: quote.demo
        ? "Demo preview: priced offline by the demo stand-in for Ivora's simulation."
        : "Priced by Ivora's simulation, the calculation bills use. Nothing was saved.",
      quote,
    };
  } catch (e) {
    return actionError(e, "tariff preview");
  }
}

function publishMessage(r: PublishResult): ActionState {
  if (r.state === "unconfirmed")
    return {
      error: `Version ${r.version} is saved in the kit, but Ivora did not confirm it yet: ${r.error} Drivers keep the previous version until then. Use "Finish saving" to try again.`,
    };
  return {
    ok: `Version ${r.version} is live: new sessions are billed with it; past and open bills keep the price they were made with.${demoNote()}`,
    warning: r.warning,
  };
}

/** Saves the editor as a new tariff, or as a new version of an existing one. */
export async function saveTariffAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  let target: string;
  try {
    const actor = await requireRole("manager");
    const existing = str(form, "tariffId") || null;
    const { id, result } = await saveTariff(
      getPricing(),
      actor,
      tariffForm(form),
      existing,
    );
    revalidatePath("/pricing", "layout");
    revalidatePath("/");
    if (existing) return publishMessage(result);
    target = `/pricing/${id}?created=${result.state === "saved" ? "1" : "unconfirmed"}`;
  } catch (e) {
    return actionError(e, "tariff save");
  }
  redirect(target);
}

/**
 * Repeats the unconfirmed steps of a save: looks the version up in Ivora, creates it
 * again as a new attempt if Ivora doesn't have it, and archives older versions.
 */
export async function finishTariffAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireRole("manager");
    const r = await publishTariff(
      getPricing(),
      actor,
      str(form, "tariffId") ?? "",
    );
    revalidatePath("/pricing", "layout");
    return publishMessage(r);
  } catch (e) {
    return actionError(e, "tariff finish");
  }
}

/** Gives up on an unconfirmed version (Ivora is checked first). */
export async function discardTariffAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  let removed: boolean;
  try {
    const actor = await requireRole("manager");
    const r = await discardPendingVersion(
      getPricing(),
      actor,
      str(form, "tariffId") ?? "",
    );
    revalidatePath("/pricing", "layout");
    revalidatePath("/");
    removed = r.tariffRemoved;
    if (!removed)
      return {
        ok: `Version ${r.version} is discarded. Drivers keep the current version.${demoNote()}`,
      };
  } catch (e) {
    return actionError(e, "tariff discard");
  }
  redirect("/pricing");
}

/** A station's tariff, its connectors' tariffs and whether it is private. */
export async function setStationPricingAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireRole("manager");
    const connectors: Record<string, string> = {};
    for (const [k, v] of form.entries())
      if (k.startsWith("connector.") && typeof v === "string")
        connectors[k.slice("connector.".length)] = v;
    const { stationName } = await setStationPricing(getPricing(), actor, {
      stationId: str(form, "stationId"),
      revision: str(form, "revision"),
      tariffId: str(form, "tariffId"),
      private: form.get("private") === "on",
      connectors,
    });
    revalidatePath("/pricing", "layout");
    revalidatePath("/");
    return {
      ok: `Prices saved for ${stationName}.${demoNote()}`,
    };
  } catch (e) {
    return actionError(e, "station pricing");
  }
}

/** Demo only: back to the sample tariffs. */
export async function resetDemoPricingAction(): Promise<void> {
  if (!isDemo()) return;
  await requireRole("manager");
  await resetDemoPricing();
  revalidatePath("/pricing", "layout");
}
