"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { actionError } from "@/lib/server/action-errors";
import { requireRole } from "@/lib/server/auth";
import { isDemo } from "@/lib/server/env";
import { resetDemoFleet } from "@/lib/server/ivora/demo-cookie";
import {
  getLive,
  recheckCommand,
  resendCommand,
  sendCommand,
  type LiveCommand,
} from "@/lib/server/live";
import { resetDemoLive } from "@/lib/server/live/demo-cookie";

// Technicians and above send, re-check and send again charger commands. Every action checks the
// signed-in staff member's role on the server first (requireRole), the live service
// checks it again, and the database checks it in the same statement that claims the
// command.

const str = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" && v !== "" ? v : undefined;
};

const demoNote = () =>
  isDemo() ? " Demo: simulated, nothing was sent to Ivora or a charger." : "";

function refresh(stationId?: number | string) {
  revalidatePath("/live");
  if (stationId) revalidatePath(`/live/stations/${stationId}`);
  revalidatePath("/");
}

const WHAT: Record<LiveCommand["action"], string> = {
  start: "Remote start",
  stop: "Stop",
  reset: "Reset",
  unlock: "Unlock",
};

/** Says what Ivora and the charger answered, never more than they did. */
function describe(c: LiveCommand): ActionState {
  const what = WHAT[c.action];
  switch (c.phase) {
    case "accepted":
      return {
        ok: `${what} accepted by the charger${c.chargerStatus ? ` (${c.chargerStatus})` : ""}. The status below shows when it has happened.${demoNote()}`,
      };
    case "failed":
      return { error: `${what} not done. ${c.error ?? ""}`.trim() };
    case "unknown":
      return { error: `${what}: outcome unknown. ${c.error ?? ""}`.trim() };
    case "pending":
      return c.error
        ? { warning: c.error, ok: `${what} pending.` }
        : {
            ok: `${what} sent. Waiting for the charger to answer: check again in a few seconds.`,
          };
  }
}

export async function sendCommandAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const stationId = str(form, "stationId");
  try {
    const actor = await requireRole("technician");
    const c = await sendCommand(getLive(), actor, {
      requestId: str(form, "requestId"),
      stationId,
      action: str(form, "action"),
      connectorId: str(form, "connectorId"),
      transactionId: str(form, "transactionId"),
      mode: str(form, "mode"),
      confirmed: str(form, "confirm") === "on",
      sessions: form.getAll("session").filter((v) => typeof v === "string"),
    });
    refresh(c.stationId);
    return describe(c);
  } catch (e) {
    refresh(stationId);
    return actionError(e, "live command");
  }
}

export async function recheckCommandAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireRole("technician");
    const c = await recheckCommand(getLive(), actor, str(form, "id") ?? "");
    refresh(c.stationId);
    return describe(c);
  } catch (e) {
    refresh();
    return actionError(e, "live command check");
  }
}

/** Sends an unconfirmed command again: same key, within a minute, sessions re-read. */
export async function resendCommandAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireRole("technician");
    if (str(form, "confirm") !== "on")
      return { error: "Tick the box to send the same command again." };
    const c = await resendCommand(getLive(), actor, str(form, "id") ?? "");
    refresh(c.stationId);
    return describe(c);
  } catch (e) {
    refresh();
    return actionError(e, "live command resend");
  }
}

/** Demo only: back to the sample chargers and no commands. */
export async function resetDemoLiveAction(): Promise<void> {
  if (!isDemo()) return;
  await requireRole("technician");
  await resetDemoLive();
  await resetDemoFleet();
  refresh();
}
