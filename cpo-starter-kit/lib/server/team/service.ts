import "server-only";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { z } from "zod";
import {
  atLeast,
  canChangeRole,
  canInvite,
  canRemove,
  leavesNoOwner,
  ROLE_LABELS,
  type Role,
} from "@/lib/roles";
import { inviteEmail, MailerError, type Email, type Mailer } from "../mail";
import { limit, type RateLimiter } from "../rate-limit";
import {
  emailInput,
  firstIssue,
  inviteTokenInput,
  linkTokenInput,
  operatorNameInput,
  passwordInput,
  idInput,
  roleInput,
  userIdInput,
} from "./input";
import {
  invalidInvite,
  lastOwner,
  TeamError,
  type Accounts,
  type Member,
  type Staff,
  type TeamBackend,
} from "./types";

// Team rules, shared by demo and live mode. Every function that changes something
// takes the signed-in staff member and checks their role here, on the server, before
// it touches the backend. Logs carry record IDs and error codes only: never emails,
// passwords or tokens.

export const INVITE_TTL_HOURS = 72;

export interface TeamDeps {
  backend: TeamBackend;
  /** Supabase Auth logins; null in demo mode. */
  accounts: Accounts | null;
  limiter: RateLimiter;
  /** HMAC key for rate-limit subjects. */
  secret: string;
  /** Null in demo mode, and in live mode when no email provider is set. */
  mailer: Mailer | null;
  appUrl: string;
  setupSecret: string;
  now: () => Date;
}

export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new TeamError("invalid", firstIssue(r.error));
  return r.data;
}

function allow(ok: boolean, message: string) {
  if (!ok) throw new TeamError("not_allowed", message);
}

function accountsOf(d: TeamDeps): Accounts {
  if (d.backend.mode === "demo" || !d.accounts)
    throw new TeamError(
      "demo_only",
      "Demo mode: you are signed in as the demo owner. Nothing to do here.",
    );
  return d.accounts;
}

/** Same digest on both sides, so the comparison takes the same time for any input. */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

async function memberOf(d: TeamDeps, actor: Staff, userId: string) {
  const team = await d.backend.members(actor.operatorId);
  const target = team.find((m) => m.userId === userId);
  if (!target)
    throw new TeamError("not_found", "This person is not on the team.");
  return { team, target };
}

export async function loadTeam(
  d: TeamDeps,
  actor: Staff,
): Promise<{
  members: Member[];
  invites: Awaited<ReturnType<TeamBackend["pendingInvites"]>>;
}> {
  const [members, invites] = await Promise.all([
    d.backend.members(actor.operatorId),
    atLeast(actor.role, "manager")
      ? d.backend.pendingInvites(actor.operatorId)
      : Promise.resolve([]),
  ]);
  return { members, invites };
}

export interface InviteOutcome {
  email: string;
  role: Role;
  /** True when the provider accepted the email. */
  emailed: boolean;
  /** The link to share by hand: demo mode, or live mode without an email provider. */
  link: string | null;
  /** Demo mode: the email that would have been sent. */
  preview: Email | null;
}

export async function inviteStaff(
  d: TeamDeps,
  actor: Staff,
  raw: { email: unknown; role: unknown },
): Promise<InviteOutcome> {
  const email = parse(emailInput, raw.email);
  const role = parse(roleInput, raw.role);
  allow(
    canInvite(actor.role, role),
    actor.role === "manager"
      ? "Managers can invite technicians and viewers. Ask an owner to invite managers and owners."
      : "Only owners and managers can invite staff.",
  );
  await limit(
    d.limiter,
    d.secret,
    "inviteActor",
    actor.userId,
    "You have sent many invites in the last hour. Try again later.",
  );
  await limit(
    d.limiter,
    d.secret,
    "inviteRecipient",
    `${actor.operatorId}:${email}`,
    "This person was invited several times in the last hour. Try again later.",
  );
  const token = randomBytes(32).toString("base64url");
  const id = await d.backend.createInvite({
    operatorId: actor.operatorId,
    email,
    role,
    tokenHash: hashToken(token),
    invitedBy: actor.userId,
    expiresAt: new Date(d.now().getTime() + INVITE_TTL_HOURS * 3_600_000),
  });
  // The token rides in the fragment, which browsers never send to servers or logs.
  const link = `${d.appUrl}/invite#${token}`;
  const mail = inviteEmail({
    to: email,
    operatorName: actor.operatorName,
    roleLabel: ROLE_LABELS[role],
    link,
    expiresHours: INVITE_TTL_HOURS,
  });
  if (d.backend.mode === "demo")
    return { email, role, emailed: false, link, preview: mail };
  if (!d.mailer) return { email, role, emailed: false, link, preview: null };
  try {
    await d.mailer.send(mail, `cpo-invite-${id}`);
  } catch (e) {
    console.warn("cpo-starter-kit: invite email failed", {
      invite: id,
      status: e instanceof MailerError ? e.status : null,
    });
    // An invite nobody received is no use; revoke it so the next try starts clean.
    await d.backend.revokeInvite(actor.operatorId, id).catch(() => false);
    throw new TeamError(
      "email_failed",
      "The email provider could not send the invite. Try again in a few minutes.",
    );
  }
  console.info("cpo-starter-kit: invite sent", { invite: id });
  return { email, role, emailed: true, link: null, preview: null };
}

export async function revokeStaffInvite(
  d: TeamDeps,
  actor: Staff,
  rawId: unknown,
): Promise<void> {
  allow(
    atLeast(actor.role, "manager"),
    "Only owners and managers can revoke invites.",
  );
  const id = parse(idInput, rawId);
  const invite = (await d.backend.pendingInvites(actor.operatorId)).find(
    (i) => i.id === id,
  );
  if (!invite)
    throw new TeamError(
      "not_found",
      "This invite was already used or revoked.",
    );
  allow(
    canInvite(actor.role, invite.role),
    "Only an owner can revoke this invite.",
  );
  await d.backend.revokeInvite(actor.operatorId, id);
}

export async function changeStaffRole(
  d: TeamDeps,
  actor: Staff,
  raw: { userId: unknown; role: unknown },
): Promise<void> {
  const userId = parse(userIdInput, raw.userId);
  const to = parse(roleInput, raw.role);
  allow(
    atLeast(actor.role, "manager"),
    "Only owners and managers can change roles.",
  );
  const { team, target } = await memberOf(d, actor, userId);
  if (target.role === to) return;
  // The team was read above; the backend writes only if these roles still hold.
  const checked = { actor: { userId: actor.userId, role: actor.role }, target };
  allow(
    canChangeRole(actor, target, to),
    actor.role === "manager"
      ? "Managers can change technicians and viewers, to technician or viewer."
      : "Your role does not allow this change.",
  );
  // The database checks this again, atomically, for changes made at the same time.
  if (leavesNoOwner(team, userId, to)) throw lastOwner();
  await d.backend.setRole(actor.operatorId, checked, to);
}

export async function removeStaff(
  d: TeamDeps,
  actor: Staff,
  rawUserId: unknown,
): Promise<void> {
  const userId = parse(userIdInput, rawUserId);
  allow(
    atLeast(actor.role, "manager"),
    "Only owners and managers can remove staff.",
  );
  const { team, target } = await memberOf(d, actor, userId);
  allow(
    canRemove(actor, target),
    actor.userId === userId
      ? "You can't remove yourself. Ask another owner."
      : "Managers can remove technicians and viewers only.",
  );
  if (leavesNoOwner(team, userId, null)) throw lastOwner();
  await d.backend.removeMember(actor.operatorId, {
    actor: { userId: actor.userId, role: actor.role },
    target,
  });
  // Removing the login too ends their sessions and frees the email for a new invite.
  if (d.accounts)
    await d.accounts.deleteUser(userId).catch((e: unknown) => {
      console.warn("cpo-starter-kit: login not deleted", {
        user: userId,
        error: e instanceof Error ? e.name : "error",
      });
    });
}

export interface InviteView {
  email: string;
  role: Role;
  operatorName: string;
  expiresAt: string;
  /** Already signed in with the invited email: joins with this login, no password. */
  signedIn: boolean;
}

/** What the invite page shows before the person accepts. */
export async function lookupInvite(
  d: TeamDeps,
  rawToken: unknown,
  source: string | null,
): Promise<InviteView> {
  await limit(d.limiter, d.secret, "acceptSource", source);
  const token = parse(inviteTokenInput, rawToken);
  const invite = await d.backend.findInvite(hashToken(token));
  if (
    !invite ||
    invite.state !== "pending" ||
    Date.parse(invite.expiresAt) <= d.now().getTime()
  )
    throw invalidInvite();
  const current =
    d.backend.mode === "live" ? await d.accounts?.currentUser() : null;
  return {
    email: invite.email,
    role: invite.role,
    operatorName: invite.operatorName,
    expiresAt: invite.expiresAt,
    signedIn: current?.email === invite.email,
  };
}

/**
 * Accept an invite: create the login for the invited email, or use an existing login
 * with that email (already signed in, or proven with its password), join the team in
 * one database step, and sign in. An existing login that is not staff yet, for
 * example after an earlier removal, can join this way too.
 */
export async function acceptStaffInvite(
  d: TeamDeps,
  raw: { token: unknown; password: unknown },
  source: string | null,
): Promise<InviteView> {
  const invite = await lookupInvite(d, raw.token, source);
  const tokenHash = hashToken(raw.token as string);
  if (d.backend.mode === "demo") {
    parse(passwordInput, raw.password);
    // Demo mode stores no password; the new sample member joins the demo team.
    await d.backend.acceptInvite(tokenHash, randomUUID(), invite.email);
    return invite;
  }
  const accounts = accountsOf(d);
  const current = await accounts.currentUser();
  let userId: string;
  let password: string | null = null;
  let created = false;
  if (current?.email === invite.email) userId = current.id;
  else {
    password = parse(passwordInput, raw.password);
    const made = await accounts.createUser(invite.email, password);
    if (made === "exists") {
      // Their own login: the password proves it (and signs them in).
      await limit(
        d.limiter,
        d.secret,
        "passwordAccount",
        invite.email,
        "Too many sign-in attempts. Wait ten minutes and try again.",
      );
      const existing = await accounts.signInWithPassword(
        invite.email,
        password,
      );
      if (!existing)
        throw new TeamError(
          "account_exists",
          "A login with this email already exists. Enter its password, or ask for a sign-in link on the sign-in page and then open this invite again.",
        );
      userId = existing;
    } else {
      userId = made;
      created = true;
    }
  }
  try {
    await d.backend.acceptInvite(tokenHash, userId, invite.email);
  } catch (e) {
    if (created) await accounts.deleteUser(userId).catch(() => undefined);
    throw e;
  }
  if (created && password)
    await accounts.signInWithPassword(invite.email, password);
  console.info("cpo-starter-kit: invite accepted", { user: userId });
  return invite;
}

/** The setup screen: creates the first owner, once, with the setup secret. */
export async function setupOwner(
  d: TeamDeps,
  raw: {
    secret: unknown;
    operatorName: unknown;
    email: unknown;
    password: unknown;
  },
  source: string | null,
): Promise<void> {
  const accounts = accountsOf(d);
  await limit(
    d.limiter,
    d.secret,
    "setupSource",
    source,
    "Too many setup attempts. Wait ten minutes and try again.",
  );
  if (d.setupSecret.length < 16)
    throw new TeamError(
      "setup_disabled",
      "Setup is off. Set SETUP_SECRET (at least 16 characters) in the deployment's environment variables and redeploy.",
    );
  // Once set up, the secret is not even compared: nothing left to guess at.
  if (await d.backend.hasStaff())
    throw new TeamError(
      "setup_done",
      "Setup is already done. Sign in instead.",
    );
  if (typeof raw.secret !== "string" || !sameSecret(raw.secret, d.setupSecret))
    throw new TeamError("setup_secret", "The setup secret is not right.");
  const operatorName = parse(operatorNameInput, raw.operatorName);
  const email = parse(emailInput, raw.email);
  const password = parse(passwordInput, raw.password);
  const userId = await accounts.createUser(email, password);
  if (userId === "exists")
    throw new TeamError(
      "account_exists",
      "A login with this email already exists in Supabase Auth. Use another email, or delete that user in the Supabase dashboard.",
    );
  try {
    await d.backend.bootstrapOwner(userId, email, operatorName);
  } catch (e) {
    await accounts.deleteUser(userId).catch(() => undefined);
    throw e;
  }
  await accounts.signInWithPassword(email, password);
  console.info("cpo-starter-kit: first owner created", { user: userId });
}

/**
 * After any sign-in: only staff stay signed in, plus someone with a pending invite for
 * their email, so they can open the invite and join with this login.
 */
async function staffOrSignOut(
  d: TeamDeps,
  accounts: Accounts,
  userId: string,
  email: string,
) {
  const staff = await d.backend.staffForUser(userId);
  if (staff) return staff;
  if (await d.backend.hasPendingInvite(email))
    throw new TeamError(
      "invite_pending",
      "You are signed in, but not on the team yet. Open your invite link again to join.",
    );
  await accounts.signOut();
  throw new TeamError(
    "no_access",
    "This login is not on the team. Ask an owner or manager for an invite.",
  );
}

export async function signInWithPassword(
  d: TeamDeps,
  raw: { email: unknown; password: unknown },
  source: string | null,
): Promise<Staff> {
  const accounts = accountsOf(d);
  const email = parse(emailInput, raw.email);
  const password =
    typeof raw.password === "string" && raw.password.length <= 200
      ? raw.password
      : "";
  const message = "Too many sign-in attempts. Wait ten minutes and try again.";
  await limit(d.limiter, d.secret, "passwordSource", source, message);
  await limit(d.limiter, d.secret, "passwordAccount", email, message);
  const userId = password
    ? await accounts.signInWithPassword(email, password)
    : null;
  if (!userId)
    throw new TeamError("sign_in_failed", "The email or password is wrong.");
  return staffOrSignOut(d, accounts, userId, email);
}

/** Emails a sign-in link to staff. Answers the same for any address. */
export async function requestSignInLink(
  d: TeamDeps,
  raw: { email: unknown },
  source: string | null,
): Promise<void> {
  const accounts = accountsOf(d);
  const email = parse(emailInput, raw.email);
  const message = "Wait a minute before asking for another link.";
  await limit(d.limiter, d.secret, "linkSource", source, message);
  await limit(d.limiter, d.secret, "linkRecipient", email, message);
  if (
    (await d.backend.isStaffEmail(email)) ||
    (await d.backend.hasPendingInvite(email))
  )
    await accounts.sendSignInLink(email);
}

/** The emailed link's token (our own email). */
export async function confirmSignInLink(
  d: TeamDeps,
  rawToken: unknown,
  source: string | null,
): Promise<Staff> {
  const accounts = accountsOf(d);
  await limit(d.limiter, d.secret, "acceptSource", source);
  const token = parse(linkTokenInput, rawToken);
  if (!(await accounts.verifySignInLink(token)))
    throw new TeamError(
      "invite_invalid",
      "This sign-in link has expired or was already used. Ask for a new one.",
    );
  const user = await accounts.currentUser();
  if (!user) throw new TeamError("sign_in_failed", "Sign-in did not complete.");
  return staffOrSignOut(d, accounts, user.id, user.email);
}

/** Supabase's own email link, which comes back with a PKCE code. */
export async function completeCodeSignIn(
  d: TeamDeps,
  code: string,
): Promise<Staff> {
  const accounts = accountsOf(d);
  if (
    !/^[A-Za-z0-9_-]{8,512}$/.test(code) ||
    !(await accounts.exchangeCode(code))
  )
    throw new TeamError(
      "invite_invalid",
      "This sign-in link has expired or was already used. Ask for a new one.",
    );
  const user = await accounts.currentUser();
  if (!user) throw new TeamError("sign_in_failed", "Sign-in did not complete.");
  return staffOrSignOut(d, accounts, user.id, user.email);
}
