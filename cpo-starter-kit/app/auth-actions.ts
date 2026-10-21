"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { ROLE_LABELS } from "@/lib/roles";
import { actionError } from "@/lib/server/action-errors";
import { sourceOf } from "@/lib/server/rate-limit";
import {
  acceptStaffInvite,
  confirmSignInLink,
  getTeam,
  lookupInvite,
  requestSignInLink,
  setupOwner,
  signInWithPassword,
} from "@/lib/server/team";

// Sign-in, setup and invite acceptance. These run before anyone is signed in, so each
// is rate-limited per source (and per account where there is one). Passwords, tokens
// and email addresses are never logged.

const source = async () => sourceOf(await headers());

export async function signInAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    await signInWithPassword(
      getTeam(),
      { email: form.get("email"), password: form.get("password") },
      await source(),
    );
  } catch (e) {
    return actionError(e, "sign-in");
  }
  redirect("/");
}

export async function signInLinkAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    await requestSignInLink(
      getTeam(),
      { email: form.get("email") },
      await source(),
    );
    return {
      ok: "If this email belongs to a staff member, a sign-in link is on its way. It works once.",
    };
  } catch (e) {
    return actionError(e, "sign-in link");
  }
}

export async function confirmLinkAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    await confirmSignInLink(getTeam(), form.get("token"), await source());
  } catch (e) {
    return actionError(e, "sign-in link");
  }
  redirect("/");
}

export async function signOutAction(): Promise<void> {
  const team = getTeam();
  if (team.accounts) await team.accounts.signOut();
  redirect("/login");
}

export async function setupAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    await setupOwner(
      getTeam(),
      {
        secret: form.get("secret"),
        operatorName: form.get("operatorName"),
        email: form.get("email"),
        password: form.get("password"),
      },
      await source(),
    );
  } catch (e) {
    return actionError(e, "setup");
  }
  redirect("/team");
}

export async function lookupInviteAction(token: string): Promise<ActionState> {
  try {
    const invite = await lookupInvite(getTeam(), token, await source());
    return { invite: { ...invite, role: ROLE_LABELS[invite.role] } };
  } catch (e) {
    return actionError(e, "invite lookup");
  }
}

export async function acceptInviteAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const team = getTeam();
  try {
    const invite = await acceptStaffInvite(
      team,
      { token: form.get("token"), password: form.get("password") },
      await source(),
    );
    if (team.backend.mode === "demo")
      return {
        ok: `Demo: ${invite.email} joined the team as ${ROLE_LABELS[invite.role]}. You are still signed in as the demo owner.`,
      };
  } catch (e) {
    return actionError(e, "invite acceptance");
  }
  redirect("/");
}
