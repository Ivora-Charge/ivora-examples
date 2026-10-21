import "server-only";
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
// Idempotency-Key derived from the kit's own command record, so re-checking an
// uncertain command repeats it with the same key and it happens at most once. Logs
// carry error codes and request IDs only.

export interface LiveDeps {
  store: LiveStore;
  ivora: IvoraClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The ID tag of a remote start from the Live view. An operator start: no payment. */
export const STAFF_TOKEN = "CPO-KIT-STAFF";
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

/** Connector statuses a remote start may be sent to: free, or a vehicle waiting. */
export const STARTABLE = new Set(["Available", "Preparing"]);
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
const running = (t: Transaction) =>
  t.active === true || (t.active === null && !t.ended_at);

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

export type LiveResult =
  { ok: true; live: LiveSnapshot } | { ok: false; error: string };

function sessionView(t: Transaction, s: Station | undefined): SessionView {
  const c = s?.connectors.find((x) => x.id === t.connector_id);
  return {
    id: t.id,
    stationId: t.station_id ?? 0,
    stationName: s?.name ?? `Station ${t.station_id ?? "?"}`,
    connectorId: t.connector_id,
    connectorNumber: t.connector_number ?? c?.number ?? null,
    idToken: t.id_token ?? null,
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
): string | null {
  if (c.phase !== "accepted") return null;
  const at = Date.parse(c.requestedAt);
  if (now - at > OBSERVE_MS) return null;
  switch (c.action) {
    case "start": {
      const tx = txs.find(
        (t) =>
          t.connector_id === c.connectorId &&
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

function commandView(
  c: LiveCommand,
  stations: Map<number, Station>,
  txs: Transaction[],
  now: number,
): CommandView {
  const s = stations.get(c.stationId);
  return {
    ...c,
    stationName: s?.name ?? `Station ${c.stationId}`,
    connectorNumber:
      s?.connectors.find((x) => x.id === c.connectorId)?.number ?? null,
    observed: observe(c, s, txs, now),
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
  let locations, stations, txs: Transaction[], commands;
  try {
    [locations, stations, txs, commands] = await Promise.all([
      d.ivora.listAllLocations(),
      d.ivora.listAllStations(),
      d.ivora.listTransactions({ limit: SESSION_LIMIT }),
      d.store.listCommands(staff.operatorId, { limit: COMMAND_LIMIT }),
    ]);
    commands = await refreshPending(d, staff.operatorId, commands);
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    logIvora("live view", e);
    return { ok: false, error: describeError(e) };
  }
  const now = nowOf(d);
  const byId = new Map(stations.data.map((s) => [s.id, s]));
  const sessions = txs
    .filter(running)
    .map((t) => sessionView(t, byId.get(t.station_id ?? 0)));
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
      commands: commands.map((c) => commandView(c, byId, txs, now)),
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
): Promise<
  { ok: true; detail: StationDetail | null } | { ok: false; error: string }
> {
  let s: Station, txs: Transaction[], faults: Fault[], locations, commands;
  try {
    s = await d.ivora.getStation(stationId);
  } catch (e) {
    if (e instanceof IvoraError && e.status === 404)
      return { ok: true, detail: null };
    if (!(e instanceof IvoraError)) throw e;
    logIvora("live station", e);
    return { ok: false, error: describeError(e) };
  }
  try {
    [txs, faults, locations, commands] = await Promise.all([
      d.ivora.listTransactions({ station_id: stationId, limit: 20 }),
      d.ivora.listFaults(stationId, { limit: 20 }),
      d.ivora.listAllLocations(),
      d.store.listCommands(staff.operatorId, { stationId, limit: 10 }),
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
    return { ok: false, error: describeError(e) };
  }
  const now = nowOf(d);
  const active = txs.filter(running).map((t) => sessionView(t, s));
  const views = commands.map((c) =>
    commandView(c, new Map([[s.id, s]]), txs, now),
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
          ...sessionView(t, s),
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

const describeSession = (t: Transaction, s: Station) => {
  const n =
    t.connector_number ??
    s.connectors.find((c) => c.id === t.connector_id)?.number;
  return `session ${t.id}${n ? ` on connector ${n}` : ""}`;
};

/** The command's request body, the same on every send of the same command. */
function body(c: LiveCommand): CommandInput {
  switch (c.action) {
    case "start":
      return {
        action: "start",
        connector_id: c.connectorId!,
        token: STAFF_TOKEN,
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
  "Ivora did not confirm this command yet, so it may have reached the charger. Check again: that repeats it with the same idempotency key, so it happens at most once.";

/**
 * Sends (or re-sends, with the same key and body) a pending command without an
 * operation, then waits briefly for the charger's answer, and records the outcome.
 */
async function send(
  d: LiveDeps,
  operatorId: string,
  c: LiveCommand,
): Promise<void> {
  let op: Operation;
  try {
    op = await d.ivora.sendCommand(
      c.stationId,
      body(c),
      idempotencyKey("command", c.id, c.action),
    );
  } catch (e) {
    logIvora(`command ${c.action}`, e);
    // Only a definite refusal fails the command; anything else stays pending, and
    // checking again repeats it with the same key.
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
  let ends: Transaction[] = [];
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
          `Connector ${connector.number ?? ""} is ${connector.status ?? "in an unknown state"}. A remote start goes only to an Available connector or one with a vehicle waiting (Preparing).`,
        );
      break;
    }
    case "stop": {
      const tx = txs.find((t) => t.id === input.transactionId);
      if (!tx)
        throw new LiveError(
          "not_ready",
          "That session is not running on this charger any more. Reload the page.",
        );
      ends = [tx];
      break;
    }
    case "reset":
      if (!input.mode)
        throw new LiveError("invalid", "Choose a soft or hard reset.");
      if (!s.online)
        throw new LiveError(
          "not_ready",
          "The charger is offline, so it can't receive a reset. Power-cycle it on site.",
        );
      ends = txs;
      break;
    case "unlock":
      if (!connector) throw new LiveError("invalid", "Choose a connector.");
      ends = txs.filter((t) => t.connector_id === connector.id);
      break;
  }
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
  // The same tap again (a double click, a resubmitted form): check the command it
  // already made instead of sending a new one.
  if (!created) return recheckCommand(d, actor, command.id);
  await send(d, actor.operatorId, command);
  return reload(d, actor.operatorId, command.id);
}

/**
 * Checks a pending command again. With an operation, reads it; without one (Ivora did
 * not confirm the send), sends it again with the same key and body, which the API
 * answers with the original operation instead of a second command. Technicians and
 * above only, since it may send.
 */
export async function recheckCommand(
  d: LiveDeps,
  actor: Staff,
  id: string,
): Promise<LiveCommand> {
  if (!atLeast(actor.role, "technician")) throw notAllowed();
  const c = await reload(d, actor.operatorId, id);
  if (c.phase !== "pending") return c;
  if (c.operationId) {
    try {
      await settle(
        d,
        actor.operatorId,
        c.id,
        await d.ivora.getOperation(c.operationId),
      );
    } catch (e) {
      logIvora("command check", e);
      throw e;
    }
  } else await send(d, actor.operatorId, c);
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
] as const;

export function eventStation(e: IvoraEvent): number | null {
  const v = e.station_id ?? e.data.station_id;
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
