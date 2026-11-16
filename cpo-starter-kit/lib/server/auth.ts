import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { readsNetwork } from "@/lib/hosts";
import { atLeast, HOST_ROLE, ROLE_LABELS, type Role } from "@/lib/roles";
import { demoViewAs } from "./hosts/demo-cookie";
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
 * The signed-in staff member (or host user), or null. Demo mode is signed in as the
 * labelled demo owner, or as one of the sample host users while the visitor views the
 * app as that host (the Hosts page's demo buttons). Live mode asks Supabase Auth for
 * the session's user, then reads their role, and a host user's host, sites and
 * switches, from the database (never from user metadata). Cached per request.
 */
export const currentStaff = cache(async (): Promise<Staff | null> => {
  const team = getTeam();
  if (team.backend.mode === "demo") {
    const viewAs = await demoViewAs();
    if (viewAs) {
      const host = await team.backend.staffForUser(viewAs);
      if (host?.role === HOST_ROLE) return host;
    }
    return team.backend.staffForUser(DEMO_OWNER_ID);
  }
  const user = await team.accounts?.currentUser();
  return user ? team.backend.staffForUser(user.id) : null;
});

/** The role check itself: null staff means not signed in. Host users never pass. */
export function checkRole(staff: Staff | null, min: Role): Staff | null {
  if (staff && !atLeast(staff.role, min)) throw new AccessDeniedError(min);
  return staff;
}

/**
 * Every operator page and every server action that reads or changes something starts
 * here: `const staff = await requireRole("manager")`. Not signed in: redirects to the
 * sign-in page. A host user: 404, as for anything outside their host. Signed in with a
 * lower operator role: throws AccessDeniedError.
 */
export async function requireRole(min: Role): Promise<Staff> {
  const staff = await currentStaff();
  if (!staff) redirect("/login");
  if (staff.role === HOST_ROLE) notFound();
  return checkRole(staff, min)!;
}

/**
 * Who may read the network: operator viewers and above (every site) and host users
 * (their host's sites only; the services scope every read, see lib/server/scope.ts).
 * Throws AccessDeniedError otherwise; null means not signed in.
 */
export function checkNetworkReader(staff: Staff | null): Staff | null {
  if (staff && !readsNetwork(staff)) throw new AccessDeniedError("viewer");
  return staff;
}

/** The pages and actions of Overview, Chargers, Live and Reports start here. */
export async function requireNetworkReader(): Promise<Staff> {
  const staff = checkNetworkReader(await currentStaff());
  if (!staff) redirect("/login");
  return staff;
}
