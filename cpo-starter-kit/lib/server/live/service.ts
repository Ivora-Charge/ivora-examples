import "server-only";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { atLeast } from "@/lib/roles";
import { whToKwh } from "@/lib/units";
import {
  describeError,
  idempotencyKey,
  IvoraError,
  type CommandInput,
  type Fault,
  type IvoraClient,
  type Location,
  type Operation,
  type Station,
  type TokenRecord,
  type Transaction,
} from "../ivora";
import type { Staff } from "../team/types";
import {
  COMMAND_ACTIONS,
  LiveError,
  notAllowed,
  type CommandChanges,
  type LiveCommand,
  type LiveStore,
} from "./types";

// Live view rules, shared by demo and live mode. Reading is for everyone on the team;
// sending a command is for technicians and above, checked here on the server and again
// by the store in the same statement that claims the command. Every command carries an
// Idempotency-Key derived from the kit's own command record. "Check again" only
// re-reads; sending an uncertain command again is a separate action, allowed within a
// minute of the first send and after a fresh session check, with the same key, so it
// happens at most once. Logs carry error codes and request IDs only.

export interface LiveDeps {
  store: LiveStore;
  ivora: IvoraClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** How the operator's staff token is labelled in Ivora's token list and reports. */
export const STAFF_TOKEN_LABEL = "Staff remote start (CPO kit)";
/** The staff token's external reference in Ivora: one per operator. */
export const staffTokenReference = (operatorId: string) =>
  `cpo-staff-${operatorId}`;
/** How the operator's free charging token is labelled in Ivora. */
export const FREE_TOKEN_LABEL = "Free charging (CPO kit)";
/** The free charging token's external reference in Ivora: one per operator. */
export const freeTokenReference = (operatorId: string) =>
  `cpo-free-${operatorId}`;
/** OCPP 1.6 ID tags are at most 20 characters. */
const STAFF_TOKEN_FORMAT = /^[A-Z0-9-]{8,20}$/;
/** Sessions read for the Live view (the API's maximum page). */
export const SESSION_LIMIT = 100;
/** Commands shown, newest first. */
const COMMAND_LIMIT = 15;
/** Pending commands whose operation a page load re-reads, at most. */
const REFRESH_LIMIT = 5;
/** How long a command waits for the charger's answer (one read a second). */
const OPERATION_POLLS = 8;
/** A start the charger accepted, with no session after this, is reported as such. */
const START_WAIT_MS = 3 * 60_000;
/** Commands this old no longer get an "observed" line. */
const OBSERVE_MS = 30 * 60_000;
/** An uncertain command may be sent again (same key) only this soon after the first send. */
export const RESEND_WINDOW_MS = 60_000;
/** A pending command older than this is closed as unknown (as the database does). */
export const PENDING_MAX_MS = 15 * 60_000;

/**
 * Connector statuses a staff remote start may be sent to: free only. A driver who has
 * plugged in (Preparing) starts and pays through the normal flow.
 */
export const STARTABLE = new Set(["Available"]);
/** The charger's answers that mean yes. */
const ACCEPTED = new Set(["Accepted", "Unlocked", "Scheduled"]);

const nowOf = (d: LiveDeps) => (d.now ?? Date.now)();
const sleepOf = (d: LiveDeps) =>
  d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

function logIvora(what: string, e: unknown) {
  if (e instanceof IvoraError)
    console.error(
      `cpo-starter-kit: ${what} failed:`,
      `${e.code} (HTTP ${e.status}) ${e.requestId ?? ""}`,
    );
}

/**
 * The API refused the command outright, so it was never sent to the charger. A timeout,
 * a lost connection, outcome_unknown or request_in_progress may have reached it.
 */
function definitelyRefused(e: unknown): boolean {
  return (
    e instanceof IvoraError &&
    e.status >= 400 &&
    e.status < 500 &&
    e.status !== 408 &&
    e.status !== 429 &&
    e.code !== "request_in_progress"
  );
}

/** A session that may be running: active, or not known to have ended. */
export const running = (t: Transaction) =>
  t.active === true || (t.active === null && !t.ended_at);

/**
 * A session started with the operator's staff token. The API shows a session's token
 * masked to its last 4 characters, so that is what is compared.
 */
export function isStaffSession(
  t: { id_token?: string | null },
  staffToken: string | null,
): boolean {
  return sameToken(t, staffToken);
}

/** A session started with the operator's free charging token (driver checkout). */
export function isFreeSession(
  t: { id_token?: string | null },
  freeToken: string | null,
): boolean {
  return sameToken(t, freeToken);
}

function sameToken(t: { id_token?: string | null }, token: string | null) {
  if (!token || !t.id_token) return false;
  return t.id_token === token || t.id_token === `****${token.slice(-4)}`;
}

const TOKEN_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A new random staff token: STAFF and 15 random characters (about 75 bits). */
export function newStaffToken(): string {
  return randomToken("STAFF");
}

/** A new random free charging token: FREE and 16 random characters (80 bits). */
export function newFreeToken(): string {
  return randomToken("FREE");
}

function randomToken(prefix: string) {
  let t = prefix;
  while (t.length < 20) t += TOKEN_CHARS[randomInt(TOKEN_CHARS.length)];
  return t;
}

const validCoord = (lat: unknown, lng: unknown) =>
  typeof lat === "number" &&
  typeof lng === "number" &&
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lng) <= 180;

// ---- Views ----

export type StationState = "online" | "offline" | "faulted";

export interface SessionView {
  id: number;
  stationId: number;
  stationName: string;
  connectorId: number | null;
  connectorNumber: number | null;
  /** The API shows the last 4 characters behind ****. */
  idToken: string | null;
  /** Started with the operator's staff token (a remote start from the Live view). */
  staff: boolean;
  /** Started with the operator's free charging token (a driver on a free tariff). */
  free: boolean;
  startedAt: string | null;
  energyKwh: number;
}

export interface ConnectorView {
  id: number;
  number: number;
  status: string;
  maxPowerKw: number | null;
  session: SessionView | null;
  openFaults: number;
}

export interface StationView {
  id: number;
  name: string;
  siteId: number | null;
  state: StationState;
  online: boolean;
  protocol: string | null;
  lastSeen: string | null;
  connectors: ConnectorView[];
  openFaults: number;
  sessions: SessionView[];
}

export interface SiteView {
  id: number | null;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  stations: StationView[];
}

export interface FaultView {
  id: string;
  stationId: number;
  stationName: string;
  connectorNumber: number | null;
  open: boolean;
  errorCode: string | null;
  info: string | null;
  status: string | null;
  openedAt: string;
  clearedAt: string | null;
}

export interface CommandView extends LiveCommand {
  stationName: string;
  connectorNumber: number | null;
  /** What the view shows has happened since, for a command the charger accepted. */
  observed: string | null;
  /**
   * Until when it may be sent again (UTC): set for a pending command Ivora never
   * confirmed, within a minute of its first send.
   */
  resendUntil: string | null;
}

/** A map marker: one site, its worst state, and counts by state. */
export interface MapPoint {
  id: number;
  name: string;
  lat: number;
  lng: number;
  state: StationState;
  online: number;
  offline: number;
  faulted: number;
}

export interface LiveSnapshot {
  mode: "live" | "demo";
  readAt: string;
  sites: SiteView[];
  points: MapPoint[];
  sessions: SessionView[];
  faults: FaultView[];
  commands: CommandView[];
  counts: {
    stations: number;
    online: number;
    offline: number;
    faulted: number;
    charging: number;
    connectors: number;
  };
  /** More sites or chargers than the client pages through. */
  truncated: boolean;
}

/**
 * A failed read. retryAfter (seconds) is set when Ivora rate-limited it, so the
 * browser waits that long before it reads again.
 */
export interface LiveFailure {
  ok: false;
  error: string;
  retryAfter: number | null;
}

export type LiveResult = { ok: true; live: LiveSnapshot } | LiveFailure;

/** Seconds to wait after a 429: Retry-After, else a minute. */
function retryAfter(e: IvoraError): number | null {
  return e.status === 429 ? Math.max(e.retryAfterSeconds ?? 60, 10) : null;
}

function sessionView(
  t: Transaction,
  s: Station | undefined,
  staffToken: string | null,
  freeToken: string | null = null,
): SessionView {
  const c = s?.connectors.find((x) => x.id === t.connector_id);
  return {
    id: t.id,
    stationId: t.station_id ?? 0,
    stationName: s?.name ?? `Station ${t.station_id ?? "?"}`,
    connectorId: t.connector_id,
    connectorNumber: t.connector_number ?? c?.number ?? null,
    idToken: t.id_token ?? null,
    staff: isStaffSession(t, staffToken),
    free: isFreeSession(t, freeToken),
    startedAt: t.started_at,
    energyKwh: whToKwh(t.energy_wh ?? 0),
  };
}

function stationView(s: Station, sessions: SessionView[]): StationView {
  const faults = s.open_faults ?? [];
  const mine = sessions.filter((x) => x.stationId === s.id);
  const connectors = s.connectors.map((c, i) => ({
    id: c.id,
    number: c.number ?? i + 1,
    status: s.online ? (c.status ?? "Unknown") : "Offline",
    maxPowerKw: c.max_power_w ? c.max_power_w / 1000 : null,
    session: mine.find((x) => x.connectorId === c.id) ?? null,
    openFaults: faults.filter((f) => f.connector_id === c.id).length,
  }));
  const faulted =
    faults.length > 0 || s.connectors.some((c) => c.status === "Faulted");
  return {
    id: s.id,
    name: s.name,
    siteId: s.location_id ?? null,
    state: !s.online ? "offline" : faulted ? "faulted" : "online",
    online: s.online,
    protocol: s.protocol ?? null,
    lastSeen: s.last_seen ?? null,
    connectors,
    openFaults: faults.length,
    sessions: mine,
  };
}

function faultView(f: Fault, s: Station | undefined): FaultView {
  return {
    id: f.id,
    stationId: f.station_id,
    stationName: s?.name ?? `Station ${f.station_id}`,
    connectorNumber:
      s?.connectors.find((c) => c.id === f.connector_id)?.number ?? null,
    open: f.open,
    errorCode: f.error_code,
    info: f.info ?? null,
    status: f.ocpp_status ?? null,
    openedAt: f.opened_at,
    clearedAt: f.cleared_at,
  };
}

/**
 * What has visibly happened since a command the charger accepted, read from the
 * current sessions and station state rather than assumed from the answer.
 */
export function observe(
  c: LiveCommand,
  s: Station | undefined,
  txs: Transaction[],
  now: number,
  staffToken: string | null,
): string | null {
  if (c.phase !== "accepted") return null;
  const at = Date.parse(c.requestedAt);
  if (now - at > OBSERVE_MS) return null;
  switch (c.action) {
    case "start": {
      // Only a session with the staff token is this command's; a driver's own session
      // on the same connector is not.
      const tx = txs.find(
        (t) =>
          t.connector_id === c.connectorId &&
          isStaffSession(t, staffToken) &&
          Date.parse(t.started_at ?? "") >= at - 5_000,
      );
      if (tx)
        return running(tx)
          ? `Session ${tx.id} started.`
          : `Session ${tx.id} started and has ended.`;
      return now - at < START_WAIT_MS
        ? "Waiting for the session to start (a vehicle may need to be plugged in)."
        : "No session started. The charger may have stopped waiting for a vehicle.";
    }
    case "stop": {
      const tx = txs.find((t) => t.id === c.transactionId);
      return tx && running(tx)
        ? `Waiting for the charger to end session ${c.transactionId}.`
        : `Session ${c.transactionId} ended.`;
    }
    case "reset": {
      if (!s) return null;
      if (!s.online) return "The charger is restarting (offline).";
      const seen = Date.parse(s.last_seen ?? "");
      return seen > at
        ? "The charger is back online."
        : "Waiting for the charger to restart.";
    }
    case "unlock":
      return c.chargerStatus === "Unlocked" ? "Connector unlocked." : null;
  }
}

function resendUntil(c: LiveCommand, now: number): string | null {
  if (c.phase !== "pending" || c.operationId) return null;
  const until = Date.parse(c.requestedAt) + RESEND_WINDOW_MS;
  return now <= until ? new Date(until).toISOString() : null;
}

function commandView(
  c: LiveCommand,
  stations: Map<number, Station>,
  txs: Transaction[],
  now: number,
  staffToken: string | null,
): CommandView {
  const s = stations.get(c.stationId);
  return {
    ...c,
    stationName: s?.name ?? `Station ${c.stationId}`,
    connectorNumber:
      s?.connectors.find((x) => x.id === c.connectorId)?.number ?? null,
    observed: observe(c, s, txs, now, staffToken),
    resendUntil: resendUntil(c, now),
  };
}

/**
 * Re-reads the operation of pending commands that have one (no command is sent), so a
 * page load shows answers that arrived without a webhook. A few per load, within the
 * API's rate limit.
 */
async function refreshPending(
  d: LiveDeps,
  operatorId: string,
  commands: LiveCommand[],
): Promise<LiveCommand[]> {
  const due = commands
    .filter((c) => c.phase === "pending" && c.operationId)
    .slice(0, REFRESH_LIMIT);
  if (!due.length) return commands;
  await Promise.all(
    due.map(async (c) => {
      try {
        const changes = fromOperation(
          await d.ivora.getOperation(c.operationId!),
        );
        if (changes.phase !== "pending")
          await d.store.record(operatorId, c.id, changes);
      } catch (e) {
        logIvora("command refresh", e);
      }
    }),
  );
  return d.store.listCommands(operatorId, { limit: COMMAND_LIMIT });
}

/** Everything the Live page shows. Reads only (it re-reads pending operations). */
export async function loadLive(d: LiveDeps, staff: Staff): Promise<LiveResult> {
  let locations, stations, txs: Transaction[], commands, token, free;
  try {
    [locations, stations, txs, commands, token, free] = await Promise.all([
      d.ivora.listAllLocations(),
      d.ivora.listAllStations(),
      d.ivora.listTransactions({ limit: SESSION_LIMIT }),
      d.store.listCommands(staff.operatorId, { limit: COMMAND_LIMIT }),
      d.store.getStaffToken(staff.operatorId),
      d.store.getFreeToken(staff.operatorId),
    ]);
    commands = await refreshPending(d, staff.operatorId, commands);
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    logIvora("live view", e);
    return { ok: false, error: describeError(e), retryAfter: retryAfter(e) };
  }
  const now = nowOf(d);
  const staffToken = token?.idToken ?? null;
  const byId = new Map(stations.data.map((s) => [s.id, s]));
  const sessions = txs
    .filter(running)
    .map((t) =>
      sessionView(
        t,
        byId.get(t.station_id ?? 0),
        staffToken,
        free?.idToken ?? null,
      ),
    );
  const views = stations.data.map((s) => stationView(s, sessions));
  const siteOf = new Map<number, Location>(
    locations.data.map((l) => [l.id, l]),
  );
  const sites: SiteView[] = locations.data
    .map((l) => ({
      id: l.id,
      name: l.name,
      address: [l.address, l.city].filter(Boolean).join(", ") || null,
      lat: validCoord(l.latitude, l.longitude) ? l.latitude! : null,
      lng: validCoord(l.latitude, l.longitude) ? l.longitude! : null,
      stations: views.filter((v) => v.siteId === l.id),
    }))
    .filter((s) => s.stations.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  const unsited = views.filter(
    (v) => v.siteId === null || !siteOf.has(v.siteId),
  );
  if (unsited.length)
    sites.push({
      id: null,
      name: "No site",
      address: null,
      lat: null,
      lng: null,
      stations: unsited,
    });
  for (const s of sites)
    s.stations.sort((a, b) => a.name.localeCompare(b.name));
  const points: MapPoint[] = sites
    .filter((s) => s.id !== null && s.lat !== null && s.lng !== null)
    .map((s) => {
      const n = (st: StationState) =>
        s.stations.filter((x) => x.state === st).length;
      const faulted = n("faulted");
      const offline = n("offline");
      return {
        id: s.id!,
        name: s.name,
        lat: s.lat!,
        lng: s.lng!,
        state: faulted ? "faulted" : offline ? "offline" : "online",
        online: n("online"),
        offline,
        faulted,
      };
    });
  const faults = stations.data
    .flatMap((s) => (s.open_faults ?? []).map((f) => faultView(f, s)))
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  return {
    ok: true,
    live: {
      mode: d.ivora.mode,
      readAt: new Date(now).toISOString(),
      sites,
      points,
      sessions,
      faults,
      commands: commands.map((c) => commandView(c, byId, txs, now, staffToken)),
      counts: {
        stations: views.length,
        online: views.filter((v) => v.online).length,
        offline: views.filter((v) => v.state === "offline").length,
        faulted: views.filter((v) => v.state === "faulted").length,
        charging: sessions.length,
        connectors: views.reduce((n, v) => n + v.connectors.length, 0),
      },
      truncated: stations.truncated || locations.truncated,
    },
  };
}

export interface StationDetail {
  mode: "live" | "demo";
  readAt: string;
  station: StationView;
  siteName: string | null;
  /** Recent sessions of this station, running ones first. */
  recent: (SessionView & { active: boolean; endedAt: string | null })[];
  /** Open and recent faults (`GET /stations/{id}/faults`). */
  faults: FaultView[];
  commands: CommandView[];
  /** A command on this charger is still waiting for an answer. */
  pending: CommandView | null;
}

/** One charger's live detail: status, sessions, faults and recent commands. */
export async function loadStation(
  d: LiveDeps,
  staff: Staff,
  stationId: number,
): Promise<{ ok: true; detail: StationDetail | null } | LiveFailure> {
  let s: Station,
    txs: Transaction[],
    faults: Fault[],
    locations,
    commands,
    token,
    free;
  try {
    s = await d.ivora.getStation(stationId);
  } catch (e) {
    if (e instanceof IvoraError && e.status === 404)
      return { ok: true, detail: null };
    if (!(e instanceof IvoraError)) throw e;
    logIvora("live station", e);
    return { ok: false, error: describeError(e), retryAfter: retryAfter(e) };
  }
  try {
    [txs, faults, locations, commands, token, free] = await Promise.all([
      d.ivora.listTransactions({ station_id: stationId, limit: 20 }),
      d.ivora.listFaults(stationId, { limit: 20 }),
      d.ivora.listAllLocations(),
      d.store.listCommands(staff.operatorId, { stationId, limit: 10 }),
      d.store.getStaffToken(staff.operatorId),
      d.store.getFreeToken(staff.operatorId),
    ]);
    if (commands.some((c) => c.phase === "pending" && c.operationId)) {
      await refreshPending(d, staff.operatorId, commands);
      commands = await d.store.listCommands(staff.operatorId, {
        stationId,
        limit: 10,
      });
    }
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    logIvora("live station", e);
    return { ok: false, error: describeError(e), retryAfter: retryAfter(e) };
  }
  const now = nowOf(d);
  const staffToken = token?.idToken ?? null;
  const freeToken = free?.idToken ?? null;
  const active = txs
    .filter(running)
    .map((t) => sessionView(t, s, staffToken, freeToken));
  const views = commands.map((c) =>
    commandView(c, new Map([[s.id, s]]), txs, now, staffToken),
  );
  return {
    ok: true,
    detail: {
      mode: d.ivora.mode,
      readAt: new Date(now).toISOString(),
      station: stationView(s, active),
      siteName:
        locations.data.find((l) => l.id === s.location_id)?.name ?? null,
      recent: txs
        .map((t) => ({
          ...sessionView(t, s, staffToken, freeToken),
          active: running(t),
          endedAt: t.ended_at,
        }))
        .sort((a, b) => Number(b.active) - Number(a.active)),
      faults: faults.map((f) => faultView(f, s)),
      commands: views,
      pending: views.find((c) => c.phase === "pending") ?? null,
    },
  };
}

// ---- Commands ----

const sessionIds = z
  .array(z.coerce.number().int().positive())
  .max(50, "Too many sessions.");

const commandInput = z.object({
  requestId: z.uuid("Reload the page and try again."),
  stationId: z.coerce.number().int().positive(),
  action: z.enum(COMMAND_ACTIONS, "Choose a command."),
  connectorId: z.coerce.number().int().positive().optional(),
  transactionId: z.coerce.number().int().positive().optional(),
  mode: z.enum(["soft", "hard"], "Choose a soft or hard reset.").optional(),
  confirmed: z.literal(true, "Tick the box to confirm the command."),
  sessions: sessionIds,
});

export type CommandRequest = z.input<typeof commandInput>;

function parse(raw: unknown) {
  const r = commandInput.safeParse(raw);
  if (!r.success)
    throw new LiveError(
      "invalid",
      r.error.issues[0]?.message ?? "Check the form and try again.",
    );
  return r.data;
}

const VERB: Record<LiveCommand["action"], string> = {
  start: "remote start",
  stop: "stop",
  reset: "reset",
  unlock: "unlock",
};

/** The running sessions a command would end. */
function sessionsEnded(
  c: Pick<LiveCommand, "action" | "connectorId" | "transactionId">,
  txs: Transaction[],
): Transaction[] {
  switch (c.action) {
    case "start":
      return [];
    case "stop":
      return txs.filter((t) => t.id === c.transactionId);
    case "reset":
      return txs;
    case "unlock":
      return txs.filter((t) => t.connector_id === c.connectorId);
  }
}

const describeSession = (t: Transaction, s: Station) => {
  const n =
    t.connector_number ??
    s.connectors.find((c) => c.id === t.connector_id)?.number;
  return `session ${t.id}${n ? ` on connector ${n}` : ""}`;
};

/**
 * The operator's staff token, registered in its Ivora token list once (on the first
 * remote start) and idempotently: a random token is stored first, so two first uses at
 * once register the same one; the create carries a key derived from the operator and
 * is found again by its external reference. A token already in Ivora under that
 * reference is adopted. Remote starts use it, so staff sessions are labelled in
 * Ivora's sessions and reports instead of using a shared, unregistered tag.
 */
export async function ensureStaffToken(
  d: LiveDeps,
  operatorId: string,
): Promise<string> {
  const stored = await d.store.getStaffToken(operatorId);
  if (stored?.tokenId) return stored.idToken;
  const reference = staffTokenReference(operatorId);
  const usable = (t: TokenRecord) => {
    if (!STAFF_TOKEN_FORMAT.test(t.id_token))
      throw new LiveError(
        "not_ready",
        `The staff token in Ivora (${reference}) can't be read back. Remove it in Ivora and try again.`,
      );
    if (t.status !== "Accepted")
      throw new LiveError(
        "not_ready",
        `The staff token in Ivora (${reference}) is ${t.status}. Accept it in Ivora to use remote start.`,
      );
    return d.store
      .putStaffToken(
        operatorId,
        { idToken: t.id_token, tokenId: t.id },
        { replace: true },
      )
      .then((x) => x.idToken);
  };
  const found = await d.ivora.findToken(reference);
  if (found) return usable(found);
  const token =
    stored ??
    (await d.store.putStaffToken(operatorId, {
      idToken: newStaffToken(),
      tokenId: null,
    }));
  return usable(
    await d.ivora.createToken(
      {
        id_token: token.idToken,
        type: "Central",
        status: "Accepted",
        label: STAFF_TOKEN_LABEL,
        external_reference: reference,
      },
      idempotencyKey("staff-token", operatorId, "create"),
    ),
  );
}

/**
 * The operator's free charging token, registered once like the staff token (type
 * Central, external_reference cpo-free-<operator>, a key derived from the operator,
 * adopted when it already exists). Unlike the staff token, Ivora is asked every time:
 * blocking the token in Ivora turns free starts off at once. Null when it is blocked
 * (or can't be read back): then there are no free starts.
 */
export async function ensureFreeToken(
  d: {
    store: Pick<LiveStore, "getFreeToken" | "putFreeToken">;
    ivora: Pick<IvoraClient, "findToken" | "createToken">;
  },
  operatorId: string,
): Promise<string | null> {
  const reference = freeTokenReference(operatorId);
  const usable = async (t: TokenRecord) => {
    if (!STAFF_TOKEN_FORMAT.test(t.id_token) || t.status !== "Accepted")
      return null;
    return (
      await d.store.putFreeToken(
        operatorId,
        { idToken: t.id_token, tokenId: t.id },
        { replace: true },
      )
    ).idToken;
  };
  const found = await d.ivora.findToken(reference);
  if (found) return usable(found);
  const token =
    (await d.store.getFreeToken(operatorId)) ??
    (await d.store.putFreeToken(operatorId, {
      idToken: newFreeToken(),
      tokenId: null,
    }));
  return usable(
    await d.ivora.createToken(
      {
        id_token: token.idToken,
        type: "Central",
        status: "Accepted",
        label: FREE_TOKEN_LABEL,
        external_reference: reference,
      },
      idempotencyKey("free-token", operatorId, "create"),
    ),
  );
}

/** The command's request body, the same on every send of the same command. */
function body(c: LiveCommand, staffToken: string | null): CommandInput {
  switch (c.action) {
    case "start":
      if (!staffToken) throw new Error("Remote start needs the staff token");
      return {
        action: "start",
        connector_id: c.connectorId!,
        token: staffToken,
        token_type: "Central",
      };
    case "stop":
      return { action: "stop", transaction_id: c.transactionId! };
    case "reset":
      return { action: "reset", mode: c.mode! };
    case "unlock":
      return { action: "unlock", connector_id: c.connectorId! };
  }
}

/** What an operation says about a command. */
export function fromOperation(op: Operation): CommandChanges {
  const status =
    typeof op.result?.charger_status === "string"
      ? op.result.charger_status.slice(0, 40)
      : null;
  switch (op.status) {
    case "dispatching":
      return { phase: "pending", operationId: op.id };
    case "rejected": {
      const e = op.result?.error as {
        code?: unknown;
        message?: unknown;
      } | null;
      const code = typeof e?.code === "string" ? e.code : "rejected";
      const message =
        typeof e?.message === "string" ? e.message : "The command was rejected";
      return {
        phase: "failed",
        operationId: op.id,
        chargerStatus: status,
        error: `Ivora refused the command (${code}): ${message}.`,
      };
    }
    case "unknown":
      return {
        phase: "unknown",
        operationId: op.id,
        chargerStatus: status,
        error:
          "Ivora could not confirm the charger received this command. Check the connector status and sessions before sending it again.",
      };
    case "succeeded":
      // The charger answered. No status means the adapter replied without one: the
      // view then watches the sessions and status to see what happened.
      if (status && !ACCEPTED.has(status))
        return {
          phase: "failed",
          operationId: op.id,
          chargerStatus: status,
          error: `The charger answered ${status}.`,
        };
      return {
        phase: "accepted",
        operationId: op.id,
        chargerStatus: status,
        error: null,
      };
  }
}

const UNCERTAIN =
  "Ivora did not confirm this command yet, so it may have reached the charger. Within a minute of the first send you can send it again: that repeats it with the same idempotency key, so it happens at most once. After that it closes as unknown.";

const LATE =
  "Not sent again: Ivora never confirmed it, and more than a minute has passed since it was sent, so it may still reach the charger or may have already. Check the charger's status and sessions, then send a new command if it is still needed.";

/**
 * Sends (or re-sends, with the same key and body) a pending command without an
 * operation, then waits briefly for the charger's answer, and records the outcome.
 */
async function send(
  d: LiveDeps,
  operatorId: string,
  c: LiveCommand,
  staffToken: string | null,
): Promise<void> {
  let op: Operation;
  try {
    op = await d.ivora.sendCommand(
      c.stationId,
      body(c, staffToken),
      idempotencyKey("command", c.id, c.action),
    );
  } catch (e) {
    logIvora(`command ${c.action}`, e);
    // Only a definite refusal fails the command; anything else stays pending, and
    // can be sent again (same key) within a minute.
    await d.store.record(
      operatorId,
      c.id,
      definitelyRefused(e)
        ? { phase: "failed", error: describeError(e) }
        : { phase: "pending", error: UNCERTAIN },
    );
    return;
  }
  await d.store.record(operatorId, c.id, {
    phase: "pending",
    operationId: op.id,
    error: null,
  });
  await settle(d, operatorId, c.id, op);
}

/** Waits a few seconds for an operation to be answered, then records it. */
async function settle(
  d: LiveDeps,
  operatorId: string,
  id: string,
  op: Operation,
): Promise<void> {
  try {
    for (let i = 0; i < OPERATION_POLLS && op.status === "dispatching"; i++) {
      await sleepOf(d)(1000);
      op = await d.ivora.getOperation(op.id);
    }
  } catch (e) {
    // Sent: a later check reads the operation again.
    logIvora("command answer", e);
  }
  await d.store.record(operatorId, id, fromOperation(op));
}

async function reload(
  d: LiveDeps,
  operatorId: string,
  id: string,
): Promise<LiveCommand> {
  const c = await d.store.getCommand(operatorId, id);
  if (!c)
    throw new LiveError(
      "not_found",
      "That command is not in the kit. Reload the page.",
    );
  return c;
}

/**
 * Sends one charger command from the Live view, once the staff member has confirmed
 * it. Technicians and above only. The station is read first: a remote start goes only
 * to a free connector (or one with a vehicle waiting), and a stop, reset or unlock that
 * would end a driver's session needs that session named in the confirmation. The
 * command is claimed atomically (one per tap, one pending per charger) before it is
 * sent with an Idempotency-Key derived from its record.
 */
export async function sendCommand(
  d: LiveDeps,
  actor: Staff,
  raw: unknown,
): Promise<LiveCommand> {
  if (!atLeast(actor.role, "technician")) throw notAllowed();
  const input = parse(raw);
  const s = await d.ivora.getStation(input.stationId);
  const txs = (
    await d.ivora.listTransactions({ station_id: s.id, limit: 20 })
  ).filter(running);
  const connector = input.connectorId
    ? s.connectors.find((c) => c.id === input.connectorId)
    : undefined;
  switch (input.action) {
    case "start": {
      if (!s.online)
        throw new LiveError("not_ready", "The charger is offline.");
      if (!connector) throw new LiveError("invalid", "Choose a connector.");
      if (
        !STARTABLE.has(connector.status ?? "") ||
        txs.some((t) => t.connector_id === connector.id)
      )
        throw new LiveError(
          "not_ready",
          `Connector ${connector.number ?? ""} is ${connector.status ?? "in an unknown state"}. A staff remote start goes only to an Available connector; a driver who has plugged in starts and pays as usual.`,
        );
      break;
    }
    case "stop":
      if (!txs.some((t) => t.id === input.transactionId))
        throw new LiveError(
          "not_ready",
          "That session is not running on this charger any more. Reload the page.",
        );
      break;
    case "reset":
      if (!input.mode)
        throw new LiveError("invalid", "Choose a soft or hard reset.");
      if (!s.online)
        throw new LiveError(
          "not_ready",
          "The charger is offline, so it can't receive a reset. Power-cycle it on site.",
        );
      break;
    case "unlock":
      if (!connector) throw new LiveError("invalid", "Choose a connector.");
      break;
  }
  const ends = sessionsEnded(
    {
      action: input.action,
      connectorId: connector?.id ?? null,
      transactionId: input.transactionId ?? null,
    },
    txs,
  );
  // Never end a driver's session implicitly: every session the command would end must
  // be named in the confirmation. A session that started since the form was opened is
  // not, so the command is refused until it is reviewed.
  const confirmed = new Set(input.sessions);
  const unconfirmed = ends.filter((t) => !confirmed.has(t.id));
  if (unconfirmed.length)
    throw new LiveError(
      "confirm",
      `This ${VERB[input.action]} ends ${unconfirmed.map((t) => describeSession(t, s)).join(" and ")}. Reload the page, review the session and confirm it by name.`,
    );
  // Registered once per operator, before the command is claimed.
  const staffToken =
    input.action === "start"
      ? await ensureStaffToken(d, actor.operatorId)
      : null;
  const { command, created } = await d.store.claim(actor, {
    requestId: input.requestId,
    stationId: s.id,
    action: input.action,
    connectorId:
      input.action === "start" || input.action === "unlock"
        ? connector!.id
        : null,
    transactionId: input.action === "stop" ? input.transactionId! : null,
    mode: input.action === "reset" ? input.mode! : null,
    confirmedSessions: ends.map((t) => t.id),
  });
  // The same tap again (a double click, a resubmitted form): show the command it
  // already made. Read-only: the first request is still sending it.
  if (!created) return command;
  await send(d, actor.operatorId, command, staffToken);
  return reload(d, actor.operatorId, command.id);
}

const ageOf = (d: LiveDeps, c: LiveCommand) =>
  nowOf(d) - Date.parse(c.requestedAt);

/** Closes a pending command as unknown: staff check the charger and start a new one. */
async function closeUnknown(
  d: LiveDeps,
  operatorId: string,
  c: LiveCommand,
  error: string,
): Promise<LiveCommand> {
  await d.store.record(operatorId, c.id, { phase: "unknown", error });
  return reload(d, operatorId, c.id);
}

/**
 * Checks a pending command again: reads its operation, if it has one, and records the
 * answer. It never sends anything. A command Ivora never confirmed is closed as unknown
 * once the minute in which it may be sent again has passed, and any pending command
 * after 15 minutes, as the database does.
 */
export async function recheckCommand(
  d: LiveDeps,
  actor: Staff,
  id: string,
): Promise<LiveCommand> {
  if (!atLeast(actor.role, "technician")) throw notAllowed();
  const c = await reload(d, actor.operatorId, id);
  if (c.phase !== "pending") return c;
  const age = ageOf(d, c);
  if (!c.operationId)
    return age > RESEND_WINDOW_MS
      ? closeUnknown(d, actor.operatorId, c, LATE)
      : c;
  let changes: CommandChanges;
  try {
    changes = fromOperation(await d.ivora.getOperation(c.operationId));
  } catch (e) {
    logIvora("command check", e);
    throw e;
  }
  if (changes.phase !== "pending")
    await d.store.record(actor.operatorId, c.id, changes);
  else if (age > PENDING_MAX_MS)
    return closeUnknown(
      d,
      actor.operatorId,
      c,
      "Ivora did not confirm this command within 15 minutes. Check the charger before sending it again.",
    );
  return reload(d, actor.operatorId, c.id);
}

/**
 * Sends a command Ivora never confirmed again, as its own explicit action: the same
 * Idempotency-Key and body, so the API answers with the first send's operation if that
 * arrived. Allowed only within a minute of the first send, and only after the
 * charger's sessions are read again: a session the command would end that was not
 * confirmed (or, for a start, a connector that is no longer free) closes it as unknown,
 * so staff review the charger and confirm a new command. Technicians and above only.
 */
export async function resendCommand(
  d: LiveDeps,
  actor: Staff,
  id: string,
): Promise<LiveCommand> {
  if (!atLeast(actor.role, "technician")) throw notAllowed();
  const c = await reload(d, actor.operatorId, id);
  if (c.phase !== "pending") return c;
  // It reached Ivora: there is an answer to read, nothing to send.
  if (c.operationId) return recheckCommand(d, actor, id);
  if (ageOf(d, c) > RESEND_WINDOW_MS)
    return closeUnknown(d, actor.operatorId, c, LATE);
  const s = await d.ivora.getStation(c.stationId);
  const txs = (
    await d.ivora.listTransactions({ station_id: s.id, limit: 20 })
  ).filter(running);
  // Read again after the session check: the minute may have passed meanwhile.
  if (ageOf(d, c) > RESEND_WINDOW_MS)
    return closeUnknown(d, actor.operatorId, c, LATE);
  const confirmed = new Set(c.confirmedSessions);
  const unconfirmed = sessionsEnded(c, txs).filter((t) => !confirmed.has(t.id));
  if (unconfirmed.length)
    return closeUnknown(
      d,
      actor.operatorId,
      c,
      `Not sent again: it would now end ${unconfirmed.map((t) => describeSession(t, s)).join(" and ")}, which was not confirmed. Check the charger, then send a new command and confirm the session by name.`,
    );
  if (c.action === "start") {
    const connector = s.connectors.find((x) => x.id === c.connectorId);
    if (
      !connector ||
      !STARTABLE.has(connector.status ?? "") ||
      txs.some((t) => t.connector_id === c.connectorId)
    )
      return closeUnknown(
        d,
        actor.operatorId,
        c,
        `Not sent again: the connector is ${connector?.status ?? "gone"} now, so the first send may have started it, or a driver is using it. Check the charger before starting it again.`,
      );
  }
  const staffToken =
    c.action === "start"
      ? ((await d.store.getStaffToken(actor.operatorId))?.idToken ?? null)
      : null;
  await send(d, actor.operatorId, c, staffToken);
  return reload(d, actor.operatorId, c.id);
}

// ---- Webhooks ----

/** The delivery body: compact JSON with id, type, tenant_id, resource_id and data. */
export interface IvoraEvent {
  id: string;
  type: string;
  tenant_id: number;
  resource_id?: string;
  created_at?: string;
  station_id?: number | null;
  data: Record<string, unknown>;
}

/** The webhook events the kit subscribes to (scripts/ivora-webhook.mjs). */
export const WEBHOOK_EVENTS = [
  "station.connected",
  "station.disconnected",
  "station.booted",
  "connector.status_changed",
  "station.fault_opened",
  "station.fault_cleared",
  "charging_session.status_changed",
  "operation.completed",
  "meter.sampled",
] as const;

export function eventStation(e: IvoraEvent): number | null {
  const v = e.station_id ?? e.data.station_id;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * The transaction a charger event names, if it carries one (`transaction_id`, or a
 * `transaction` object's `id`). Only a hint: it is read from the API before use.
 */
export function eventTransaction(e: IvoraEvent): number | null {
  const tx = e.data.transaction as { id?: unknown } | undefined;
  const v = e.data.transaction_id ?? tx?.id;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * Processes a verified, new event after it was acknowledged. The event is only a cue:
 * an operation.completed re-reads its operation from the API before a command records
 * it, and every other event just tells open Live pages to re-read the API.
 */
export async function handleEvent(d: LiveDeps, e: IvoraEvent): Promise<void> {
  if (e.type === "operation.completed") {
    const op = e.data.operation as { id?: unknown } | undefined;
    const opId = typeof op?.id === "string" ? op.id : null;
    const found = opId ? await d.store.findByOperation(opId) : null;
    if (found) {
      const changes = fromOperation(await d.ivora.getOperation(opId!));
      if (changes.phase !== "pending")
        await d.store.record(found.operatorId, found.command.id, changes);
    }
  }
  await d.store.markProcessed(e.id);
}
