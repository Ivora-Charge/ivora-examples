/**
 * Staff roles, from most to least access. Roles live in the `cpo_staff` table and are
 * checked on the server; they are never read from client-editable user metadata.
 */
export const ROLES = ["owner", "manager", "technician", "viewer"] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = {
  owner: 4,
  manager: 3,
  technician: 2,
  viewer: 1,
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  manager: "Manager",
  technician: "Technician",
  viewer: "Viewer",
};

/** What each role may do. Later parts add to these lines as their modules land. */
export const ROLE_SUMMARY: Record<Role, string> = {
  owner:
    "Everything, including adding and removing owners. There is always at least one owner.",
  manager:
    "Runs the network day to day: company details, brand and payments; removes chargers; invites, changes and removes technicians and viewers.",
  technician:
    "Works on chargers: adds, tests and edits them, prints QR stickers, and starts, stops, resets and unlocks them from the Live view. Cannot remove chargers or change the team.",
  viewer:
    "Reads the overview, chargers, the Live view and reports. Cannot change anything.",
};

export function isRole(value: unknown): value is Role {
  return (
    typeof value === "string" && (ROLES as readonly string[]).includes(value)
  );
}

/** True when `role` grants at least the access of `min`. */
export function atLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

/**
 * Roles `actor` may hand out (by invite or role change). Owners may grant any role;
 * managers only roles below their own; everyone else none.
 */
export function assignableRoles(actor: Role): Role[] {
  if (actor === "owner") return [...ROLES];
  if (actor === "manager") return ["technician", "viewer"];
  return [];
}

export interface StaffRef {
  userId: string;
  role: Role;
}

/** May `actor` change someone currently holding `target`'s role at all? */
function manages(actor: StaffRef, target: StaffRef): boolean {
  if (actor.role === "owner") return true;
  return actor.role === "manager" && RANK[target.role] < RANK.manager;
}

export function canInvite(actor: Role, role: Role): boolean {
  return assignableRoles(actor).includes(role);
}

/**
 * Role changes. Owners may change anyone, themselves included (the database still
 * refuses to demote the last owner); managers only technicians and viewers, and only
 * to roles below their own.
 */
export function canChangeRole(
  actor: StaffRef,
  target: StaffRef,
  to: Role,
): boolean {
  if (to === target.role) return false;
  return manages(actor, target) && assignableRoles(actor.role).includes(to);
}

/** Removal. Nobody removes themselves (ask another owner); the last owner is kept. */
export function canRemove(actor: StaffRef, target: StaffRef): boolean {
  return actor.userId !== target.userId && manages(actor, target);
}

/** Would this change leave the team without an owner? `to` null means removal. */
export function leavesNoOwner(
  team: StaffRef[],
  userId: string,
  to: Role | null,
): boolean {
  const target = team.find((s) => s.userId === userId);
  if (!target || target.role !== "owner" || to === "owner") return false;
  return !team.some((s) => s.userId !== userId && s.role === "owner");
}
