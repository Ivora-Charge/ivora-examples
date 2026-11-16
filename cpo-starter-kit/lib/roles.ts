/**
 * Operator staff roles, from most to least access. Roles live in the `cpo_staff` table
 * and are checked on the server; they are never read from client-editable user
 * metadata.
 */
export const ROLES = ["owner", "manager", "technician", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/**
 * A site host's user (network mode): tied to exactly one host, sees only that host's
 * sites, and may do only what the operator switched on for the host (lib/hosts.ts).
 * Not an operator role: it ranks below every one of them, so every check for an
 * operator role (`atLeast(role, "viewer")` and up) refuses it.
 */
export const HOST_ROLE = "host" as const;
export type MemberRole = Role | typeof HOST_ROLE;

const RANK: Record<MemberRole, number> = {
  owner: 4,
  manager: 3,
  technician: 2,
  viewer: 1,
  host: 0,
};

export const ROLE_LABELS: Record<MemberRole, string> = {
  owner: "Owner",
  manager: "Manager",
  technician: "Technician",
  viewer: "Viewer",
  host: "Host",
};

/** What each role may do. Later parts add to these lines as their modules land. */
export const ROLE_SUMMARY: Record<MemberRole, string> = {
  owner:
    "Everything, including adding and removing owners. There is always at least one owner.",
  manager:
    "Runs the network day to day: company details, brand and payments; prices and tariffs; roaming settings; RFID cards (with the Cards module); site hosts; removes chargers; invites, changes and removes technicians, viewers and host users.",
  technician:
    "Works on chargers: adds, tests and edits them, prints QR stickers, and starts, stops, resets and unlocks them from the Live view. Cannot remove chargers or change the team.",
  viewer:
    "Reads the overview, chargers, the Live view, reports and cards. Cannot change anything.",
  host: "A site host's user: sees only that host's sites, chargers, live status, sessions and reports. Changes only what the operator switched on for the host on the Hosts page.",
};

export function isRole(value: unknown): value is Role {
  return (
    typeof value === "string" && (ROLES as readonly string[]).includes(value)
  );
}

/** An operator role or the host role. */
export function isMemberRole(value: unknown): value is MemberRole {
  return isRole(value) || value === HOST_ROLE;
}

/** True when `role` grants at least the access of the operator role `min`. */
export function atLeast(role: MemberRole, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

/**
 * Operator roles `actor` may hand out (by invite or role change). Owners may grant any
 * role; managers only roles below their own; everyone else none. Host users are
 * invited with a host instead (canInviteHostUser).
 */
export function assignableRoles(actor: MemberRole): Role[] {
  if (actor === "owner") return [...ROLES];
  if (actor === "manager") return ["technician", "viewer"];
  return [];
}

export interface StaffRef {
  userId: string;
  role: MemberRole;
}

/** May `actor` change someone currently holding `target`'s role at all? */
function manages(actor: StaffRef, target: StaffRef): boolean {
  if (actor.role === "owner") return true;
  return actor.role === "manager" && RANK[target.role] < RANK.manager;
}

export function canInvite(actor: MemberRole, role: Role): boolean {
  return assignableRoles(actor).includes(role);
}

/**
 * Role changes. Owners may change anyone, themselves included (the database still
 * refuses to demote the last owner); managers only technicians and viewers, and only
 * to roles below their own. A host user's role is not changed: they belong to a host,
 * so remove them and invite again instead.
 */
export function canChangeRole(
  actor: StaffRef,
  target: StaffRef,
  to: Role,
): boolean {
  if (to === target.role || target.role === HOST_ROLE) return false;
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
