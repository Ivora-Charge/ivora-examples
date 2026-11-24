"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { HOST_PERMISSIONS } from "@/lib/hosts";
import { HOST_ROLE } from "@/lib/roles";
import { actionError } from "@/lib/server/action-errors";
import { requireRole } from "@/lib/server/auth";
import { isDemo } from "@/lib/server/env";
import {
  archiveHost,
  assignSite,
  getHosts,
  saveHost,
} from "@/lib/server/hosts";
import { resetDemoHosts, setDemoViewAs } from "@/lib/server/hosts/demo-cookie";
import { getNetwork, saveFeePlan } from "@/lib/server/network";
import { setDemoPayout } from "@/lib/server/network/demo";
import {
  cookieDemoNetwork,
  resetDemoNetwork,
} from "@/lib/server/network/demo-cookie";
import type { PayoutStatus } from "@/lib/server/network/types";
import { getTeam } from "@/lib/server/team";
import { resetDemoTeam } from "@/lib/server/team/demo-cookie";

// Owners and managers manage hosts. Every action checks the signed-in staff member's
// role on the server first (requireRole), the host service checks it again, and the
// database checks it in the same statement as the write.

const str = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : undefined;
};

const demoNote = () =>
  isDemo()
    ? " Demo: saved in this browser only, nothing was sent anywhere."
    : "";

function refresh() {
  revalidatePath("/hosts");
  revalidatePath("/team");
  revalidatePath("/chargers");
  revalidatePath("/live");
  revalidatePath("/reports");
  revalidatePath("/reports/statements");
}

/**
 * A new network fee version for a host, effective now: sessions started after it use
 * it, earlier ones keep theirs. Owners and managers.
 */
export async function saveFeeAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const values = {
    mode: str(form, "mode") ?? "",
    percent: str(form, "percent") ?? "",
    perKwh: str(form, "perKwh") ?? "",
    monthly: str(form, "monthly") ?? "",
  };
  try {
    const actor = await requireRole("manager");
    await saveFeePlan(getNetwork(), actor, str(form, "hostId"), values);
    refresh();
    return {
      ok: `Network fee saved. It applies to sessions started from now on.${demoNote()}`,
      savedAt: Date.now(),
    };
  } catch (e) {
    return { ...actionError(e, "host fee save"), values };
  }
}

const PAYOUT_STATES: PayoutStatus[] = ["none", "action_needed", "ready"];

/** Demo only: simulate a host's payout status (Stripe is never asked). */
export async function simulatePayoutAction(form: FormData): Promise<void> {
  if (!isDemo()) return;
  await requireRole("manager");
  const status = str(form, "status") as PayoutStatus;
  const hostId = str(form, "hostId") ?? "";
  if (
    !PAYOUT_STATES.includes(status) ||
    !/^demo-host-[a-z0-9-]{1,40}$/.test(hostId)
  )
    return;
  await setDemoPayout(cookieDemoNetwork(), hostId, status);
  refresh();
}

/** Adds a host (no `id`) or saves one; unticked switches are off. */
export async function saveHostAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const values = {
    name: str(form, "name") ?? "",
    contactName: str(form, "contactName") ?? "",
    contactEmail: str(form, "contactEmail") ?? "",
    contactPhone: str(form, "contactPhone") ?? "",
  };
  try {
    const actor = await requireRole("manager");
    const id = str(form, "id") ?? null;
    await saveHost(await getHosts(), actor, id, {
      ...values,
      ...Object.fromEntries(HOST_PERMISSIONS.map((p) => [p, str(form, p)])),
    });
    refresh();
    return {
      ok: `${id ? "Host saved" : "Host added"}.${demoNote()}`,
      savedAt: Date.now(),
    };
  } catch (e) {
    return { ...actionError(e, "host save"), values };
  }
}

export async function archiveHostAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireRole("manager");
    if (str(form, "confirm") !== "on")
      return {
        error:
          "Tick the box to confirm: the host's users lose access at once and its sites go back to you.",
      };
    const r = await archiveHost(await getHosts(), actor, str(form, "id"));
    refresh();
    return {
      ok: `Host archived. Its sites are yours again${r.removedUsers ? `, and its ${r.removedUsers} ${r.removedUsers === 1 ? "user was" : "users were"} removed` : ""}.${demoNote()}`,
    };
  } catch (e) {
    return actionError(e, "host archive");
  }
}

export async function assignSiteAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireRole("manager");
    await assignSite(
      await getHosts(),
      actor,
      str(form, "siteId"),
      str(form, "hostId") ?? "",
    );
    refresh();
    return { ok: `Site saved.${demoNote()}`, savedAt: Date.now() };
  } catch (e) {
    return actionError(e, "site assign");
  }
}

/**
 * Demo only: view the app as a sample host user. The user must be a host user of the
 * visitor's own demo team; currentStaff() checks that again on every request.
 */
export async function viewAsHostAction(form: FormData): Promise<void> {
  if (!isDemo()) return;
  const actor = await requireRole("manager");
  const userId = str(form, "userId") ?? "";
  const team = await getTeam().backend.members(actor.operatorId);
  const target = team.find((m) => m.userId === userId);
  if (!target || target.role !== HOST_ROLE) return;
  await setDemoViewAs(target.userId);
  redirect("/");
}

/** Demo only: back to the demo owner. Open to the host view (that is who uses it). */
export async function stopViewingAsHostAction(): Promise<void> {
  if (!isDemo()) return;
  await setDemoViewAs(null);
  redirect("/hosts");
}

/** Demo only: back to the two sample hosts and their users. */
export async function resetDemoHostsAction(): Promise<void> {
  if (!isDemo()) return;
  await requireRole("manager");
  await resetDemoHosts();
  await resetDemoTeam();
  await resetDemoNetwork();
  refresh();
}
