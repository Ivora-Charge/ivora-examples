import "server-only";
import type { Role, StaffRef } from "@/lib/roles";

/** The signed-in staff member, as the server sees them. */
export interface Staff {
  userId: string;
  email: string;
  role: Role;
  operatorId: string;
  operatorName: string;
  demo: boolean;
}

export interface Member {
  userId: string;
  email: string;
  role: Role;
  createdAt: string;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}

export interface InviteRecord extends PendingInvite {
  operatorId: string;
  operatorName: string;
  /** Pending until accepted or revoked; a pending invite past `expiresAt` is expired. */
  state: "pending" | "accepted" | "revoked";
}

export type TeamErrorCode =
  | "invalid"
  | "not_allowed"
  | "rate_limited"
  | "already_staff"
  | "invite_invalid"
  | "last_owner"
  | "changed"
  | "not_found"
  | "setup_done"
  | "setup_disabled"
  | "setup_secret"
  | "account_exists"
  | "sign_in_failed"
  | "weak_password"
  | "no_access"
  | "invite_pending"
  | "email_failed"
  | "demo_full"
  | "demo_only";

/** An error the staff member can act on. The message is safe to show. */
export class TeamError extends Error {
  constructor(
    public code: TeamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TeamError";
  }
}

export const lastOwner = () =>
  new TeamError(
    "last_owner",
    "The last owner can't be removed or demoted. Make someone else an owner first.",
  );

export const changedMeanwhile = () =>
  new TeamError(
    "changed",
    "Someone changed this team member, or your own role, in the meantime. Reload the page and try again.",
  );

export const invalidInvite = () =>
  new TeamError(
    "invite_invalid",
    "This invite has expired, was revoked or was already used. Ask for a new one.",
  );

/** The roles a team change was authorized against. */
export interface Checked {
  actor: StaffRef;
  target: StaffRef;
}

/**
 * Where the team is stored. The Supabase implementation reads and writes the cpo_*
 * tables; the demo implementation keeps a sample team in a cookie and never sends a
 * request anywhere.
 */
export interface TeamBackend {
  readonly mode: "live" | "demo";
  staffForUser(userId: string): Promise<Staff | null>;
  isStaffEmail(email: string): Promise<boolean>;
  /** An unexpired, unused invite exists for this email (any operator). */
  hasPendingInvite(email: string): Promise<boolean>;
  members(operatorId: string): Promise<Member[]>;
  pendingInvites(operatorId: string): Promise<PendingInvite[]>;
  /** Replaces a pending invite for the same email. Throws `already_staff`. */
  createInvite(i: {
    operatorId: string;
    email: string;
    role: Role;
    tokenHash: string;
    invitedBy: string;
    expiresAt: Date;
  }): Promise<string>;
  revokeInvite(operatorId: string, inviteId: string): Promise<boolean>;
  findInvite(tokenHash: string): Promise<InviteRecord | null>;
  /** Single use, bound to the invited email. Throws `invite_invalid` or `already_staff`. */
  acceptInvite(tokenHash: string, userId: string, email: string): Promise<void>;
  /**
   * Applies only while the actor and target still hold the roles the server checked,
   * in the same step as the write; otherwise throws `changed`. Throws `last_owner`
   * when it would leave the operator without an owner. Revokes pending invites the
   * target may no longer send.
   */
  setRole(operatorId: string, checked: Checked, role: Role): Promise<void>;
  /** Same conditions as setRole. Also revokes the target's pending invites. */
  removeMember(operatorId: string, checked: Checked): Promise<void>;
  hasStaff(): Promise<boolean>;
  /** Works once, while nobody is staff yet. Throws `setup_done`. */
  bootstrapOwner(
    userId: string,
    email: string,
    operatorName: string,
  ): Promise<void>;
}

/** Staff logins (Supabase Auth). Live mode only: demo mode has no accounts. */
export interface Accounts {
  currentUser(): Promise<{ id: string; email: string } | null>;
  /** "exists" when the email already has a login. */
  createUser(email: string, password: string): Promise<string | "exists">;
  deleteUser(userId: string): Promise<void>;
  /** Sets the session cookies. The user ID, or null for a wrong email or password. */
  signInWithPassword(email: string, password: string): Promise<string | null>;
  sendSignInLink(email: string): Promise<void>;
  verifySignInLink(tokenHash: string): Promise<boolean>;
  exchangeCode(code: string): Promise<boolean>;
  signOut(): Promise<void>;
}
