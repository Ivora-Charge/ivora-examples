"use server";

import { revalidatePath } from "next/cache";
import type { CardsState } from "@/lib/cards-state";
import { actionError } from "@/lib/server/action-errors";
import { requireRole } from "@/lib/server/auth";
import { isDemo } from "@/lib/server/env";
import {
  addCard,
  applyImport,
  checkImport,
  getFleet,
  IMPORT_MAX_BYTES,
  newRequestId,
  updateCard,
} from "@/lib/server/fleet";
import { resetDemoCards } from "@/lib/server/ivora/demo-cards-cookie";

// Owners and managers only: every action checks the signed-in staff member's role on
// the server first (requireRole), and the fleet service checks it again (and that
// FLEET_MODULE is on). Ivora checks the API key's own permission (tokens:write).

const str = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : undefined;
};

const demoNote = () => (isDemo() ? " Demo: nothing was sent to Ivora." : "");

function failed(e: unknown, what: string): CardsState {
  const r = actionError(e, what);
  return { error: r.error, problems: r.problems };
}

/** Adds one card (POST /tokens). */
export async function addCardAction(
  _prev: CardsState,
  form: FormData,
): Promise<CardsState> {
  try {
    const actor = await requireRole("manager");
    const { card, warnings } = await addCard(getFleet(), actor, {
      value: str(form, "value"),
      kind: str(form, "kind"),
      name: str(form, "name"),
      requestId: str(form, "requestId"),
    });
    revalidatePath("/cards");
    return {
      ok: `Card ${card.masked} added for ${card.holder.name}. Chargers accept it from its next tap.${demoNote()}`,
      warnings,
      cardPath: `/cards/${card.id}`,
      requestId: newRequestId(),
    };
  } catch (e) {
    return failed(e, "card add");
  }
}

/**
 * Imports a CSV file in two steps: "check" plans it (Ivora's dry run, nothing stored),
 * then "import" applies the checked file. Each finished step hands back a new request
 * ID, so an import tried again after an uncertain answer gets a new key.
 */
export async function importCardsAction(
  prev: CardsState,
  form: FormData,
): Promise<CardsState> {
  const intent = str(form, "intent");
  let csv = str(form, "csv") ?? "";
  try {
    const actor = await requireRole("manager");
    if (intent === "import") {
      try {
        const outcome = await applyImport(
          getFleet(),
          actor,
          csv,
          str(form, "requestId") ?? "",
        );
        revalidatePath("/cards");
        const { create, update, error } = outcome.counts;
        return {
          ok: `Imported: ${create} added, ${update} relabelled${error ? `, ${error} refused` : ""}.${demoNote()}`,
          outcome,
          requestId: newRequestId(),
        };
      } catch (e) {
        return {
          ...failed(e, "card import"),
          outcome: prev.outcome,
          csv,
          requestId: newRequestId(),
        };
      }
    }
    const file = form.get("file");
    if (file instanceof File && file.size > 0) {
      if (file.size > IMPORT_MAX_BYTES)
        return {
          error: `The file is larger than ${IMPORT_MAX_BYTES / 1024} KB. Split it into smaller files.`,
        };
      csv = await file.text();
    } else csv = str(form, "text") ?? "";
    const outcome = await checkImport(getFleet(), actor, csv);
    return {
      outcome,
      csv: outcome.sendable ? csv : undefined,
      requestId: newRequestId(),
    };
  } catch (e) {
    return failed(e, "card import check");
  }
}

/** Relabels, blocks, unblocks or expires a card, or sets or clears its expiry date. */
export async function updateCardAction(
  _prev: CardsState,
  form: FormData,
): Promise<CardsState> {
  try {
    const actor = await requireRole("manager");
    const id = Number(str(form, "id"));
    const r = await updateCard(getFleet(), actor, id, {
      intent: str(form, "intent"),
      revision: str(form, "revision"),
      kind: str(form, "kind"),
      name: str(form, "name"),
      date: str(form, "date"),
    });
    revalidatePath("/cards");
    revalidatePath(`/cards/${id}`);
    return { ok: `${r.message}${r.changed ? demoNote() : ""}` };
  } catch (e) {
    return failed(e, "card change");
  }
}

/** Demo only: back to the sample cards. */
export async function resetDemoCardsAction(): Promise<void> {
  if (!isDemo()) return;
  await requireRole("manager");
  await resetDemoCards();
  revalidatePath("/cards");
}
