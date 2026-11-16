import { atLeast, HOST_ROLE, type MemberRole, type Role } from "./roles";

// Network mode: the rules for site hosts and their users, shared by the server (which
// enforces them, and the database again in the same statement as each write) and the
// pages (which only decide what to show).

/** The switches the operator sets per host. Every one is off for a new host. */
export const HOST_PERMISSIONS = [
  "editPrices",
  "control",
  "sessions",
  "invite",
  "faultEmails",
] as const;
export type HostPermission = (typeof HOST_PERMISSIONS)[number];
export type HostPermissions = Record<HostPermission, boolean>;

export const NO_PERMISSIONS: HostPermissions = {
  editPrices: false,
  control: false,
  sessions: false,
  invite: false,
  faultEmails: false,
};

export const PERMISSION_LABELS: Record<
  HostPermission,
  { label: string; hint: string }
> = {
  editPrices: {
    label: "Edit prices on own sites",
    hint: "Choose the tariff (from your published tariffs) and private access of chargers at the host's sites.",
  },
  control: {
    label: "Restart and unlock chargers on own sites",
    hint: "Reset a charger and unlock a connector from Live.",
  },
  sessions: {
    label: "Start and stop sessions on own sites",
    hint: "Remote start a free connector and stop a running session from Live.",
  },
  invite: {
    label: "Invite further users for the same host",
    hint: "Host users can invite colleagues, who get the same access.",
  },
  faultEmails: {
    label: "Receive fault emails",
    hint: "Host users get an email when a charger at one of the host's sites reports a new fault.",
  },
};

/** What the server knows about a signed-in host user's host. */
export interface HostAccess {
  id: string;
  name: string;
  /** The host's sites (Ivora location IDs), read from the kit's database. */
  siteIds: number[];
  permissions: HostPermissions;
}

/** Who is acting: an operator role, or a host user with their host. */
export interface Member {
  role: MemberRole;
  host?: HostAccess | null;
}

export const isHostUser = (m: Member): m is Member & { host: HostAccess } =>
  m.role === HOST_ROLE && Boolean(m.host);

/** What someone may try to do on the network side. */
export type NetworkAction =
  "start" | "stop" | "reset" | "unlock" | "prices" | "invite" | "hosts";

/** The host switch an action needs, or null for actions hosts never get. */
export function permissionFor(action: NetworkAction): HostPermission | null {
  switch (action) {
    case "start":
    case "stop":
      return "sessions";
    case "reset":
    case "unlock":
      return "control";
    case "prices":
      return "editPrices";
    case "invite":
      return "invite";
    case "hosts":
      return null;
  }
}

/** The operator role an action needs. */
const OPERATOR_MIN: Record<NetworkAction, Role> = {
  start: "technician",
  stop: "technician",
  reset: "technician",
  unlock: "technician",
  prices: "manager",
  invite: "manager",
  hosts: "manager",
};

/**
 * May `m` do `action`? For operator staff, their role decides. For a host user, the
 * host's switch for it must be on and, for an action on a charger or its prices,
 * `siteId` (the charger's site, as the server read it from Ivora) must be one of the
 * host's sites. Anyone else: no.
 */
export function may(
  m: Member,
  action: NetworkAction,
  siteId?: number | null,
): boolean {
  if (m.role !== HOST_ROLE) return atLeast(m.role, OPERATOR_MIN[action]);
  if (!m.host) return false;
  const permission = permissionFor(action);
  if (!permission || !m.host.permissions[permission]) return false;
  if (action === "invite") return true;
  return typeof siteId === "number" && m.host.siteIds.includes(siteId);
}

/** May `m` read the network (overview, chargers, Live, reports)? */
export function readsNetwork(m: Member): boolean {
  return m.role === HOST_ROLE ? Boolean(m.host) : atLeast(m.role, "viewer");
}

/**
 * The host filter of Chargers, Live and Reports (operator staff only): every site,
 * the operator's own sites (`?host=own`), or one host's (`?host=<host ID>`).
 */
export type HostFilter =
  { kind: "all" } | { kind: "own" } | { kind: "host"; hostId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEMO_HOST = /^demo-host-[a-z0-9-]{1,40}$/;

export function isHostId(v: unknown): v is string {
  return typeof v === "string" && (UUID.test(v) || DEMO_HOST.test(v));
}

/** The filter from the URL; anything unreadable is "all". */
export function parseHostFilter(v: string | string[] | undefined | null) {
  const s = Array.isArray(v) ? v[0] : v;
  if (s === "own") return { kind: "own" } as HostFilter;
  if (isHostId(s))
    return { kind: "host", hostId: s.toLowerCase() } as HostFilter;
  return { kind: "all" } as HostFilter;
}

/** The URL value of a filter ("" for all). */
export function hostFilterParam(f: HostFilter): string {
  return f.kind === "all" ? "" : f.kind === "own" ? "own" : f.hostId;
}

/** Which Live commands `m` may send on a charger at `siteId` (display; the server checks). */
export interface CommandRights {
  start: boolean;
  stop: boolean;
  reset: boolean;
  unlock: boolean;
}

export function commandRights(
  m: Member,
  siteId: number | null | undefined,
): CommandRights {
  return {
    start: may(m, "start", siteId),
    stop: may(m, "stop", siteId),
    reset: may(m, "reset", siteId),
    unlock: may(m, "unlock", siteId),
  };
}

export const anyCommand = (c: CommandRights) =>
  c.start || c.stop || c.reset || c.unlock;
