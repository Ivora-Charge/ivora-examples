import "server-only";
import { z } from "zod";
import {
  HOST_PERMISSIONS,
  isHostId,
  may,
  type HostAccess,
  type HostPermissions,
} from "@/lib/hosts";
import { describeError, IvoraError, type IvoraClient } from "../ivora";
import type { Staff } from "../team/types";
import {
  HostError,
  hostNotFound,
  hostsNotAllowed,
  type HostInput,
  type HostRecord,
  type HostStore,
  type SiteAssignment,
} from "./types";

// Host rules, shared by demo and live mode. Owners and managers manage hosts; every
// change checks the actor here, on the server, and the store checks it again in the
// same statement as the write. Site IDs come from the operator's own Ivora locations,
// read on the server; a site the server did not list is refused.

export interface HostDeps {
  store: HostStore;
  ivora: IvoraClient;
  /** Deletes the login of a host user removed with their host. Null in demo mode. */
  deleteLogin: ((userId: string) => Promise<void>) | null;
}

function requireAdmin(actor: Staff) {
  if (!may(actor, "hosts")) throw hostsNotAllowed();
}

const optional = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, { error: message })
    .transform((v) => (v === "" ? null : v));

const hostInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: "Enter the host's company name." })
    .max(80, { error: "Use at most 80 characters for the name." }),
  contactName: optional(80, "Use at most 80 characters for the contact."),
  contactEmail: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .transform((v) => (v === "" ? null : v))
    .pipe(
      z
        .email({ error: "Enter a valid contact email, or leave it empty." })
        .nullable(),
    ),
  contactPhone: optional(40, "Use at most 40 characters for the phone.").pipe(
    z
      .string()
      .regex(/^[0-9+()\-. ]{3,40}$/, {
        error: "Enter a phone number with digits, spaces and + ( ) - . only.",
      })
      .nullable(),
  ),
});

/** The form's fields: text, and each switch as a checkbox ("on" when ticked). */
export function parseHostInput(raw: Record<string, unknown>): HostInput {
  const r = hostInput.safeParse({
    name: raw.name ?? "",
    contactName: raw.contactName ?? "",
    contactEmail: raw.contactEmail ?? "",
    contactPhone: raw.contactPhone ?? "",
  });
  if (!r.success)
    throw new HostError(
      "invalid",
      r.error.issues[0]?.message ?? "Check the form and try again.",
    );
  const permissions = Object.fromEntries(
    HOST_PERMISSIONS.map((p) => [p, raw[p] === "on" || raw[p] === true]),
  ) as HostPermissions;
  return { ...r.data, permissions };
}

export interface SiteRow {
  id: number;
  name: string;
  address: string | null;
  /** The host the site belongs to; null for the operator's own. */
  hostId: string | null;
}

export type HostsResult =
  | {
      ok: true;
      hosts: HostRecord[];
      sites: SiteRow[];
      /** More sites than the client pages through. */
      truncated: boolean;
    }
  | { ok: false; error: string; hosts: HostRecord[] };

/** The Hosts page: every host and every site with its host. Owners and managers. */
export async function loadHosts(
  d: HostDeps,
  actor: Staff,
): Promise<HostsResult> {
  requireAdmin(actor);
  const [hosts, assigned] = await Promise.all([
    d.store.list(actor.operatorId),
    d.store.sites(actor.operatorId),
  ]);
  let locations;
  try {
    locations = await d.ivora.listAllLocations();
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    return { ok: false, error: describeError(e), hosts };
  }
  const hostOf = new Map(assigned.map((a) => [a.locationId, a.hostId]));
  return {
    ok: true,
    hosts,
    sites: locations.data
      .map((l) => ({
        id: l.id,
        name: l.name,
        address: [l.address, l.city].filter(Boolean).join(", ") || null,
        hostId: hostOf.get(l.id) ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    truncated: locations.truncated,
  };
}

const activeHost = async (d: HostDeps, actor: Staff, id: unknown) => {
  if (!isHostId(id)) throw hostNotFound();
  const h = (await d.store.list(actor.operatorId)).find(
    (x) => x.id === id && !x.archivedAt,
  );
  if (!h) throw hostNotFound();
  return h;
};

/** Adds a host (id null) or changes one. Every switch is off unless ticked. */
export async function saveHost(
  d: HostDeps,
  actor: Staff,
  id: unknown,
  raw: Record<string, unknown>,
): Promise<string> {
  requireAdmin(actor);
  const input = parseHostInput(raw);
  if (id === null || id === undefined || id === "")
    return d.store.save(actor, null, input);
  const h = await activeHost(d, actor, id);
  return d.store.save(actor, h.id, input);
}

/**
 * Archives a host: its sites go back to the operator, its invites are revoked and its
 * users removed, in one database step. Their logins are deleted after, like a
 * removal from the team.
 */
export async function archiveHost(
  d: HostDeps,
  actor: Staff,
  id: unknown,
): Promise<{ removedUsers: number }> {
  requireAdmin(actor);
  const h = await activeHost(d, actor, id);
  const removed = await d.store.archive(actor, h.id);
  if (d.deleteLogin)
    for (const userId of removed)
      await d.deleteLogin(userId).catch((e: unknown) => {
        console.warn("cpo-starter-kit: login not deleted", {
          user: userId,
          error: e instanceof Error ? e.name : "error",
        });
      });
  console.info("cpo-starter-kit: host archived", {
    host: h.id,
    removed: removed.length,
  });
  return { removedUsers: removed.length };
}

const siteIdInput = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

/**
 * Assigns one of the operator's sites to a host, or (hostId empty) back to the
 * operator. The site must be one Ivora lists for the project.
 */
export async function assignSite(
  d: HostDeps,
  actor: Staff,
  rawSiteId: unknown,
  rawHostId: unknown,
): Promise<void> {
  requireAdmin(actor);
  const site = siteIdInput.safeParse(rawSiteId);
  if (!site.success) throw new HostError("invalid", "Choose a site.");
  const hostId =
    rawHostId === "" || rawHostId === null || rawHostId === undefined
      ? null
      : (await activeHost(d, actor, rawHostId)).id;
  const locations = await d.ivora.listAllLocations();
  if (!locations.data.some((l) => l.id === site.data))
    throw new HostError(
      "not_found",
      "That site is not in your Ivora project. Reload the page.",
    );
  await d.store.assign(actor, site.data, hostId);
}

/** A host user's access from a host and the site list (demo mode resolves it so). */
export function hostAccessOf(
  hosts: HostRecord[],
  sites: SiteAssignment[],
  hostId: string,
): HostAccess | null {
  const h = hosts.find((x) => x.id === hostId && !x.archivedAt);
  if (!h) return null;
  return {
    id: h.id,
    name: h.name,
    siteIds: sites.filter((s) => s.hostId === h.id).map((s) => s.locationId),
    permissions: { ...h.permissions },
  };
}

/**
 * The operator's hosts and site assignments, for the host filter of Chargers, Live and
 * Reports. Operator staff only: a host user never gets other hosts.
 */
export async function hostDirectory(
  store: HostStore,
  staff: Staff,
): Promise<{ hosts: HostRecord[]; sites: SiteAssignment[] }> {
  if (staff.host || staff.role === "host") return { hosts: [], sites: [] };
  const [hosts, sites] = await Promise.all([
    store.list(staff.operatorId),
    store.sites(staff.operatorId),
  ]);
  return { hosts, sites };
}
