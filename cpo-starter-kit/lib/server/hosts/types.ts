import "server-only";
import type { HostPermissions } from "@/lib/hosts";
import type { Staff } from "../team/types";

/** A site host: a business whose sites carry the operator's chargers. */
export interface HostRecord {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  permissions: HostPermissions;
  createdAt: string;
  /** Archived hosts keep their record; their users and sites are gone. */
  archivedAt: string | null;
}

/** Which host a site (an Ivora location) belongs to. No row: the operator's own. */
export interface SiteAssignment {
  locationId: number;
  hostId: string;
}

export interface HostInput {
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  permissions: HostPermissions;
}

/** Someone to email about a new fault at a site. */
export interface FaultRecipient {
  operatorId: string;
  hostId: string;
  hostName: string;
  userId: string;
  email: string;
}

/**
 * Where hosts and site assignments are kept. The Supabase store reads them with the
 * signed-in user's own session (RLS: operator staff see their operator's hosts, a host
 * user only their own) and writes through database functions that check the actor's
 * role in the same statement as the write. The demo store keeps them in the visitor's
 * cookie and sends nothing anywhere.
 */
export interface HostStore {
  readonly mode: "live" | "demo";
  /** The operator's hosts, archived ones included, by name. */
  list(operatorId: string): Promise<HostRecord[]>;
  /** Every site that belongs to a host. */
  sites(operatorId: string): Promise<SiteAssignment[]>;
  /** Adds (id null) or changes a host. Owners and managers only. Returns its ID. */
  save(actor: Staff, id: string | null, input: HostInput): Promise<string>;
  /**
   * Archives a host: its sites go back to the operator, its invites are revoked and
   * its users removed. Returns the removed users' IDs.
   */
  archive(actor: Staff, id: string): Promise<string[]>;
  /** Assigns a site to a host, or (hostId null) back to the operator. */
  assign(
    actor: Staff,
    locationId: number,
    hostId: string | null,
  ): Promise<void>;
  /** Users to email about a fault at this site (live mode, webhook). */
  faultRecipients(locationId: number): Promise<FaultRecipient[]>;
}

export type HostErrorCode = "invalid" | "not_allowed" | "not_found";

/** An error the operator can act on. The message is safe to show. */
export class HostError extends Error {
  constructor(
    public code: HostErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HostError";
  }
}

export const hostNotFound = () =>
  new HostError(
    "not_found",
    "That host is not in the kit any more (it may have been archived). Reload the page.",
  );

export const hostsNotAllowed = () =>
  new HostError(
    "not_allowed",
    "Only owners and managers manage hosts. If your role just changed, reload the page.",
  );
