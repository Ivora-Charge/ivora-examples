import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { atLeast, ROLE_LABELS, type Role } from "@/lib/roles";
import { getTeam } from "./team";
import { DEMO_OWNER_ID } from "./team/demo";
import type { Staff } from "./team/types";

/** Signed in, but the role is below what the action needs. */
export class AccessDeniedError extends Error {
  constructor(public min: Role) {
    super(`This needs the ${ROLE_LABELS[min]} role or higher.`);
    this.name = "AccessDeniedError";
  }
}

/**
 * The signed-in staff member, or null. Demo mode is always signed in as the labelled
 * demo owner. Live mode asks Supabase Auth for the session's user, then reads their
 * role from the cpo_staff table (never from user metadata). Cached per request.
 */
export const currentStaff = cache(async (): Promise<Staff | null> => {
  const team = getTeam();
  if (team.backend.mode === "demo")
    return team.backend.staffForUser(DEMO_OWNER_ID);
  const user = await team.accounts?.currentUser();
  return user ? team.backend.staffForUser(user.id) : null;
});

/** The role check itself: null staff means not signed in. */
export function checkRole(staff: Staff | null, min: Role): Staff | null {
  if (staff && !atLeast(staff.role, min)) throw new AccessDeniedError(min);
  return staff;
}

/**
 * Every page and every server action that reads or changes something starts here:
 * `const staff = await requireRole("manager")`. Not signed in: redirects to the
 * sign-in page. Signed in with a lower role: throws AccessDeniedError.
 */
export async function requireRole(min: Role): Promise<Staff> {
  const staff = checkRole(await currentStaff(), min);
  if (!staff) redirect("/login");
  return staff;
}
