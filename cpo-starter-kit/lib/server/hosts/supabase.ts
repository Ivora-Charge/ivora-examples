import "server-only";
import type { HostAccess, HostPermissions } from "@/lib/hosts";
import { serviceClient, sessionClient } from "../supabase";
import {
  HostError,
  hostNotFound,
  hostsNotAllowed,
  type HostRecord,
  type HostStore,
} from "./types";

type DbError = { message: string; code?: string } | null;

function check<R extends { error: DbError }>(r: R): R {
  if (!r.error) return r;
  const m = r.error.message;
  if (m.includes("cpo_not_allowed")) throw hostsNotAllowed();
  if (m.includes("cpo_host_not_found")) throw hostNotFound();
  if (r.error.code === "23514")
    throw new HostError("invalid", "Check the host's details and try again.");
  // Not the message: it can quote values. The Postgres code is enough to debug.
  throw new Error(
    `Supabase request failed (${r.error.code ?? "unknown"}). Check the migrations and keys.`,
  );
}

const COLUMNS =
  "id, name, contact_name, contact_email, contact_phone, can_edit_prices, can_control, can_sessions, can_invite, fault_emails, created_at, archived_at";

interface Row {
  id: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  can_edit_prices: boolean;
  can_control: boolean;
  can_sessions: boolean;
  can_invite: boolean;
  fault_emails: boolean;
  created_at: string;
  archived_at: string | null;
}

const permissionsOf = (r: Row): HostPermissions => ({
  editPrices: r.can_edit_prices,
  control: r.can_control,
  sessions: r.can_sessions,
  invite: r.can_invite,
  faultEmails: r.fault_emails,
});

const toHost = (r: Row): HostRecord => ({
  id: r.id,
  name: r.name,
  contactName: r.contact_name,
  contactEmail: r.contact_email,
  contactPhone: r.contact_phone,
  permissions: permissionsOf(r),
  createdAt: r.created_at,
  archivedAt: r.archived_at,
});

/**
 * A host user's host, for the server's own check of every request: null when the host
 * is archived or gone (the user then has no access). Service role, filtered by the
 * operator and host of the user's own staff row.
 */
export async function loadHostAccess(
  svc: ReturnType<typeof serviceClient>,
  operatorId: string,
  hostId: string,
): Promise<HostAccess | null> {
  const { data: host } = check(
    await svc
      .from("cpo_hosts")
      .select(COLUMNS)
      .eq("operator_id", operatorId)
      .eq("id", hostId)
      .is("archived_at", null)
      .maybeSingle(),
  );
  if (!host) return null;
  const { data: sites } = check(
    await svc
      .from("cpo_host_sites")
      .select("location_id")
      .eq("operator_id", operatorId)
      .eq("host_id", hostId),
  );
  return {
    id: host.id,
    name: host.name,
    siteIds: (sites ?? []).map((s) => Number(s.location_id)),
    permissions: permissionsOf(host as Row),
  };
}

/**
 * Hosts and site assignments in Supabase. Reads use the signed-in user's own session,
 * so RLS limits them (operator staff: their operator's; a host user: their own host);
 * writes go through functions that check the actor's role in the same statement.
 */
export function createSupabaseHostStore(): HostStore {
  const svc = () => serviceClient();
  return {
    mode: "live",
    async list(operatorId) {
      const { data } = check(
        await (
          await sessionClient()
        )
          .from("cpo_hosts")
          .select(COLUMNS)
          .eq("operator_id", operatorId)
          .order("name"),
      );
      return ((data ?? []) as Row[]).map(toHost);
    },
    async sites(operatorId) {
      const { data } = check(
        await (
          await sessionClient()
        )
          .from("cpo_host_sites")
          .select("location_id, host_id")
          .eq("operator_id", operatorId),
      );
      return (data ?? []).map((r) => ({
        locationId: Number(r.location_id),
        hostId: r.host_id,
      }));
    },
    async save(actor, id, input) {
      const { data } = check(
        await svc().rpc("cpo_save_host", {
          p_operator_id: actor.operatorId,
          p_actor_id: actor.userId,
          p_id: id,
          p_name: input.name,
          p_contact_name: input.contactName,
          p_contact_email: input.contactEmail,
          p_contact_phone: input.contactPhone,
          p_can_edit_prices: input.permissions.editPrices,
          p_can_control: input.permissions.control,
          p_can_sessions: input.permissions.sessions,
          p_can_invite: input.permissions.invite,
          p_fault_emails: input.permissions.faultEmails,
        }),
      );
      return data as string;
    },
    async archive(actor, id) {
      const { data } = check(
        await svc().rpc("cpo_archive_host", {
          p_operator_id: actor.operatorId,
          p_actor_id: actor.userId,
          p_id: id,
        }),
      );
      return (data ?? []) as string[];
    },
    async assign(actor, locationId, hostId) {
      check(
        await svc().rpc("cpo_assign_site", {
          p_operator_id: actor.operatorId,
          p_actor_id: actor.userId,
          p_location_id: locationId,
          p_host_id: hostId,
        }),
      );
    },
    async faultRecipients(locationId) {
      const { data } = check(
        await svc().rpc("cpo_host_fault_recipients", {
          p_location_id: locationId,
        }),
      );
      return (data ?? []).map((r) => ({
        operatorId: r.operator_id,
        hostId: r.host_id,
        hostName: r.host_name,
        userId: r.user_id,
        email: r.email,
      }));
    },
  };
}
