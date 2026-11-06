"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import {
  CheckoutError,
  getCheckout,
  startSessionById,
  stopSessionById,
} from "@/lib/server/checkout";
import { config, isDemo } from "@/lib/server/env";

// Public actions for the driver session page (/s/<checkout id>): the random ID in the
// address is the only thing they need, and the server looks up the rest. The Stop
// goes through the same stop and settlement as the sticker page's.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const idOf = (form: FormData) => {
  const v = form.get("id");
  return typeof v === "string" && UUID.test(v) ? v.toLowerCase() : "";
};

function failure(e: unknown): ActionState {
  if (e instanceof CheckoutError)
    return {
      error: e.message,
      errorDetail: {
        kind: e.code,
        apiCode: e.apiCode,
        requestId: e.requestId,
      },
    };
  console.error("cpo-starter-kit: session action failed:", {
    error: e instanceof Error ? e.name : "error",
  });
  return {
    error:
      "Something went wrong on our side. Try again in a minute: a retry never charges or starts anything twice.",
    errorDetail: { kind: "server_error" },
  };
}

/** Starts the session when the automatic start did not (the connector was busy). */
export async function startSessionAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = idOf(form);
  if (isDemo() || !id) return { error: "Reload the page and try again." };
  try {
    await startSessionById(getCheckout(), id, config.operatorName);
  } catch (e) {
    revalidatePath(`/s/${id}`);
    return failure(e);
  }
  revalidatePath(`/s/${id}`);
  return {
    ok: "Start sent to the charger. This page shows when charging begins.",
  };
}

/** Stops the session: the one stop, then the final bill is settled and captured. */
export async function stopSessionAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const id = idOf(form);
  if (isDemo() || !id) return { error: "Reload the page and try again." };
  try {
    await stopSessionById(getCheckout(), id);
  } catch (e) {
    revalidatePath(`/s/${id}`);
    return failure(e);
  }
  // Stopping, until the charger confirms and the bill is settled.
  redirect(`/s/${id}?stopping=1`);
}
