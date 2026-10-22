"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { ROLE_LABELS, isRole } from "@/lib/roles";
import { actionError } from "@/lib/server/action-errors";
import { requireRole } from "@/lib/server/auth";
import { isDemo } from "@/lib/server/env";
import {
  changeStaffRole,
  getTeam,
  inviteStaff,
  removeStaff,
  revokeStaffInvite,
} from "@/lib/server/team";
import { resetDemoTeam } from "@/lib/server/team/demo-cookie";

// Every action checks the signed-in staff member's role on the server first
// (requireRole), and the team service checks what that role may do to whom.

export async function inviteAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireRole("manager");
    const r = await inviteStaff(getTeam(), actor, {
      email: form.get("email"),
      role: form.get("role"),
    });
    revalidatePath("/team");
    const who = `${r.email} (${ROLE_LABELS[r.role]})`;
    if (r.emailed) return { ok: `Invite sent to ${who}.` };
    // Same-origin path, so the demo's link opens on whatever host serves it.
    const path = `/invite${new URL(r.link!).hash}`;
    return {
      ok: r.preview
        ? `Demo: no email was sent. This is the invite ${who} would get.`
        : `Invite created for ${who}. No email provider is set, so send them this link yourself. It works once and expires in 72 hours.`,
      link: r.link!,
      path,
      preview: r.preview
        ? { to: r.preview.to, subject: r.preview.subject, text: r.preview.text }
        : undefined,
    };
  } catch (e) {
    return actionError(e, "invite");
  }
}

export async function changeRoleAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireRole("manager");
    const role = form.get("role");
    await changeStaffRole(getTeam(), actor, {
      userId: form.get("userId"),
      role,
    });
    revalidatePath("/", "layout");
    return {
      ok: `Role changed to ${isRole(role) ? ROLE_LABELS[role] : role}.`,
    };
  } catch (e) {
    return actionError(e, "role change");
  }
}

export async function removeAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireRole("manager");
    await removeStaff(getTeam(), actor, form.get("userId"));
    revalidatePath("/team");
    return { ok: "Removed from the team." };
  } catch (e) {
    return actionError(e, "removal");
  }
}

export async function revokeInviteAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireRole("manager");
    await revokeStaffInvite(getTeam(), actor, form.get("inviteId"));
    revalidatePath("/team");
    return { ok: "Invite revoked. Its link no longer works." };
  } catch (e) {
    return actionError(e, "revoke");
  }
}

/** Demo only: back to the sample team. */
export async function resetDemoAction(): Promise<void> {
  if (!isDemo()) return;
  await resetDemoTeam();
  revalidatePath("/", "layout");
}
