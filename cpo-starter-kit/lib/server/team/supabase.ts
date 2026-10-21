import "server-only";
import { isRole } from "@/lib/roles";
import type { RateLimiter } from "../rate-limit";
import { serviceClient, sessionClient } from "../supabase";
import {
  invalidInvite,
  lastOwner,
  TeamError,
  type InviteRecord,
  type Member,
  type PendingInvite,
  type TeamBackend,
} from "./types";

type DbError = { message: string; code?: string } | null;
/** The data type of the success branch of a Supabase response. */
type Ok<R> = R extends { error: null; data: infer D } ? D : never;

/**
 * The data of a successful call (null only for maybeSingle() with no row). Turns the
 * migration's named exceptions into errors staff can act on.
 */
function check<R extends { data: unknown; error: DbError }>(r: R): Ok<R> {
  if (!r.error) return r.data as Ok<R>;
  const m = r.error.message;
  if (m.includes("cpo_last_owner")) throw lastOwner();
  if (m.includes("cpo_already_staff"))
    throw new TeamError("already_staff", "This person is already on the team.");
  if (m.includes("cpo_invite_invalid")) throw invalidInvite();
  if (m.includes("cpo_setup_done"))
    throw new TeamError(
      "setup_done",
      "Setup is already done. Sign in instead.",
    );
  // Not the message: it can quote values. The Postgres code is enough to debug.
  throw new Error(
    `Supabase request failed (${r.error.code ?? "unknown"}). Check the migrations and keys.`,
  );
}

const role = (v: unknown) => {
  if (!isRole(v)) throw new Error("Unexpected role in cpo_staff");
  return v;
};

/** The team in Supabase. Reads of the team use the staff member's own session (RLS). */
export function createSupabaseBackend(): TeamBackend {
  const svc = () => serviceClient();

  return {
    mode: "live",
    async staffForUser(userId) {
      const staff = check(
        await svc()
          .from("cpo_staff")
          .select("operator_id, user_id, email, role")
          .eq("user_id", userId)
          .maybeSingle(),
      );
      if (!staff) return null;
      const op = check(
        await svc()
          .from("cpo_operators")
          .select("name")
          .eq("id", staff.operator_id)
          .single(),
      );
      return {
        userId: staff.user_id,
        email: staff.email,
        role: role(staff.role),
        operatorId: staff.operator_id,
        operatorName: op.name,
        demo: false,
      };
    },
    async isStaffEmail(email) {
      const rows = check(
        await svc()
          .from("cpo_staff")
          .select("user_id")
          .eq("email", email)
          .limit(1),
      );
      return rows.length > 0;
    },
    async members(operatorId) {
      // RLS returns only the signed-in staff member's own operator.
      const rows = check(
        await (
          await sessionClient()
        )
          .from("cpo_staff")
          .select("user_id, email, role, created_at")
          .eq("operator_id", operatorId)
          .order("created_at"),
      );
      return rows.map((r): Member => ({
        userId: r.user_id,
        email: r.email,
        role: role(r.role),
        createdAt: r.created_at,
      }));
    },
    async pendingInvites(operatorId) {
      const rows = check(
        await svc()
          .from("cpo_invites")
          .select("id, email, role, expires_at")
          .eq("operator_id", operatorId)
          .is("accepted_at", null)
          .is("revoked_at", null)
          .gt("expires_at", new Date().toISOString())
          .order("created_at"),
      );
      return rows.map((r): PendingInvite => ({
        id: r.id,
        email: r.email,
        role: role(r.role),
        expiresAt: r.expires_at,
      }));
    },
    async createInvite(i) {
      return check(
        await svc().rpc("cpo_create_invite", {
          p_operator_id: i.operatorId,
          p_email: i.email,
          p_role: i.role,
          p_token_hash: i.tokenHash,
          p_invited_by: i.invitedBy,
          p_expires_at: i.expiresAt.toISOString(),
        }),
      );
    },
    async revokeInvite(operatorId, inviteId) {
      const rows = check(
        await svc()
          .from("cpo_invites")
          .update({ revoked_at: new Date().toISOString() })
          .eq("operator_id", operatorId)
          .eq("id", inviteId)
          .is("accepted_at", null)
          .is("revoked_at", null)
          .select("id"),
      );
      return rows.length > 0;
    },
    async findInvite(tokenHash) {
      const r = check(
        await svc()
          .from("cpo_invites")
          .select(
            "id, operator_id, email, role, expires_at, accepted_at, revoked_at",
          )
          .eq("token_hash", tokenHash)
          .maybeSingle(),
      );
      if (!r) return null;
      const op = check(
        await svc()
          .from("cpo_operators")
          .select("name")
          .eq("id", r.operator_id)
          .single(),
      );
      const invite: InviteRecord = {
        id: r.id,
        operatorId: r.operator_id,
        operatorName: op.name,
        email: r.email,
        role: role(r.role),
        expiresAt: r.expires_at,
        state: r.accepted_at
          ? "accepted"
          : r.revoked_at
            ? "revoked"
            : "pending",
      };
      return invite;
    },
    async acceptInvite(tokenHash, userId, email) {
      check(
        await svc().rpc("cpo_accept_invite", {
          p_token_hash: tokenHash,
          p_user_id: userId,
          p_email: email,
        }),
      );
    },
    async setRole(operatorId, userId, to) {
      const rows = check(
        await svc()
          .from("cpo_staff")
          .update({ role: to })
          .eq("operator_id", operatorId)
          .eq("user_id", userId)
          .select("user_id"),
      );
      if (!rows.length)
        throw new TeamError("not_found", "This person is not on the team.");
    },
    async removeMember(operatorId, userId) {
      check(
        await svc()
          .from("cpo_staff")
          .delete()
          .eq("operator_id", operatorId)
          .eq("user_id", userId),
      );
    },
    async hasStaff() {
      const r = await svc()
        .from("cpo_staff")
        .select("user_id", { count: "exact", head: true });
      check(r);
      return (r.count ?? 0) > 0;
    },
    async bootstrapOwner(userId, email, operatorName) {
      check(
        await svc().rpc("cpo_bootstrap_owner", {
          p_user_id: userId,
          p_email: email,
          p_operator_name: operatorName,
        }),
      );
    },
  };
}

/** Quotas shared by every server instance, in cpo_rate_limits. */
export function createSupabaseLimiter(): RateLimiter {
  return {
    async take(key, quota, periodSeconds) {
      return check(
        await serviceClient().rpc("cpo_take_rate_limit", {
          bucket_key: key,
          quota,
          period_seconds: periodSeconds,
        }),
      );
    },
  };
}
