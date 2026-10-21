import "server-only";
import type { z } from "zod";
import { atLeast } from "@/lib/roles";
import { newStickerCode } from "@/lib/sticker-codes";
import { whToKwh } from "@/lib/units";
import {
  describeError,
  idempotencyKey,
  IvoraError,
  type IvoraClient,
  type Location,
  type Operation,
  type Station,
  type Transaction,
} from "../ivora";
import type { Staff } from "../team/types";
import { addChargerInput, connectorNumber, editChargerInput } from "./input";
import { generatePassword } from "./password";
import {
  ChargerError,
  notAllowed,
  notFound,
  type ChargerRecord,
  type ChargerStore,
  type ConnectionTest,
  type RemoteTest,
} from "./types";

// Charger rules, shared by demo and live mode. Every function that changes something
// checks the signed-in staff member's role here, on the server (technicians and above
// add, test, edit and print; managers and owners remove), and the store checks it again
// in the same statement as the write. Every Ivora write sends an Idempotency-Key
// derived from our own charger record and action. Logs carry error codes and request
// IDs only, never the charger password.

export interface ChargerDeps {
  store: ChargerStore;
  ivora: IvoraClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The ID tag a remote test session starts with. It authorizes no payment. */
export const TEST_TOKEN = "CPO-KIT-TEST";
/** A last OCPP message older than this fails the heartbeat check (Ivora asks for 60 s). */
export const HEARTBEAT_FRESH_SECONDS = 300;
/** A test whose session the charger has not reported by then fails. */
const TEST_TIMEOUT_MS = 2 * 60_000;
/** How long an action waits for the charger to answer a command (one try a second). */
const OPERATION_POLLS = 8;

const nowOf = (d: ChargerDeps) => (d.now ?? Date.now)();
const sleepOf = (d: ChargerDeps) =>
  d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

/** external_reference of the station and of a site created with it. */
export const chargerReference = (id: string) => `cpo-charger-${id}`;
export const siteReference = (id: string) => `cpo-site-${id}`;

function requireTechnician(actor: Staff) {
  if (!atLeast(actor.role, "technician")) throw notAllowed();
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new ChargerError(
      "invalid",
      r.error.issues[0]?.message ?? "Check the form and try again.",
    );
  return r.data;
}

function logIvora(what: string, e: unknown) {
  if (e instanceof IvoraError)
    console.error(
      `cpo-starter-kit: ${what} failed:`,
      `${e.code} (HTTP ${e.status}) ${e.requestId ?? ""}`,
    );
}

/** A create the API refused outright: nothing was made, so the record can go. */
function definitelyFailed(e: unknown): boolean {
  return (
    e instanceof IvoraError &&
    e.status >= 400 &&
    e.status < 500 &&
    e.status !== 408 &&
    e.status !== 429 &&
    e.code !== "request_in_progress"
  );
}

/** Waits briefly for a command, credentials change or edit to be answered. */
async function settle(d: ChargerDeps, op: Operation): Promise<Operation> {
  for (let i = 0; i < OPERATION_POLLS && op.status === "dispatching"; i++) {
    await sleepOf(d)(1000);
    op = await d.ivora.getOperation(op.id);
  }
  return op;
}

function rejection(op: Operation): { code: string; message: string } {
  const e = op.result?.error as { code?: unknown; message?: unknown } | null;
  return {
    code: typeof e?.code === "string" ? e.code : "rejected",
    message:
      typeof e?.message === "string" ? e.message : "The request was rejected",
  };
}

const chargerStatus = (op: Operation) =>
  typeof op.result?.charger_status === "string"
    ? op.result.charger_status
    : null;

// ---- Reading ----

export interface ConnectorView {
  id: number;
  number: number;
  status: string | null;
  maxPowerKw: number | null;
  code: string | null;
}

export interface ChargerView {
  /** For forms and links: the kit record ID, or `station-<id>` before the kit has one. */
  key: string;
  recordId: string | null;
  stationId: number | null;
  name: string;
  label: string;
  locationId: number | null;
  siteName: string | null;
  /** Added in the kit, but not (yet) registered in Ivora: "Finish adding". */
  pending: boolean;
  /** In the kit, but Ivora no longer has its station (deleted elsewhere). */
  missing: boolean;
  online: boolean;
  protocol: string | null;
  vendor: string | null;
  model: string | null;
  lastSeen: string | null;
  connectionUrl: string | null;
  username: string | null;
  passwordSet: boolean;
  connectors: ConnectorView[];
  connectionTest: ConnectionTest | null;
  remoteTest: RemoteTest | null;
}

export type ChargersResult =
  | {
      ok: true;
      chargers: ChargerView[];
      sites: Location[];
      truncated: boolean;
    }
  | { ok: false; error: string };

function view(
  r: ChargerRecord | null,
  s: Station | null,
  sites: Map<number, string>,
  missing = false,
): ChargerView {
  const locationId = s?.location_id ?? r?.locationId ?? null;
  const codes = new Map((r?.codes ?? []).map((c) => [c.connectorNumber, c]));
  const connectors: ConnectorView[] = s
    ? s.connectors.map((c, i) => {
        const number = c.number ?? i + 1;
        return {
          id: c.id,
          number,
          status: c.status ?? null,
          maxPowerKw: c.max_power_w ? c.max_power_w / 1000 : null,
          code: codes.get(number)?.code ?? null,
        };
      })
    : [];
  return {
    key: r ? r.id : `station-${s!.id}`,
    recordId: r?.id ?? null,
    stationId: s?.id ?? r?.stationId ?? null,
    name: s?.name ?? r!.name,
    label: r?.label ?? s?.name ?? r!.name,
    locationId,
    siteName:
      (locationId !== null ? sites.get(locationId) : undefined) ??
      r?.newSite?.name ??
      null,
    pending: Boolean(r && !r.stationId),
    missing,
    online: s?.online ?? false,
    protocol: s?.protocol ?? null,
    vendor: s?.vendor ?? null,
    model: s?.model ?? null,
    lastSeen: s?.last_seen ?? null,
    connectionUrl: s?.connection_url ?? r?.connectionUrl ?? null,
    username: s?.username ?? s?.name ?? r?.name ?? null,
    passwordSet: Boolean(r?.passwordSetAt),
    connectors,
    connectionTest: r?.connectionTest ?? null,
    remoteTest: r?.remoteTest ?? null,
  };
}

/**
 * Every charger: the stations in the Ivora project, joined with the kit's records.
 * Records the kit is still adding show as pending; stations removed from the kit stay
 * hidden (Ivora keeps a station with charging history).
 */
export async function loadChargers(
  d: ChargerDeps,
  staff: Staff,
): Promise<ChargersResult> {
  let stations, locations, records;
  try {
    [stations, locations, records] = await Promise.all([
      d.ivora.listAllStations(),
      d.ivora.listAllLocations(),
      d.store.list(staff.operatorId),
    ]);
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    logIvora("chargers list", e);
    return { ok: false, error: describeError(e) };
  }
  const sites = new Map(locations.data.map((l) => [l.id, l.name]));
  const active = records.filter((r) => !r.removedAt);
  const byStation = new Map(
    active.filter((r) => r.stationId).map((r) => [r.stationId!, r]),
  );
  const removed = new Set(
    records.filter((r) => r.removedAt && r.stationId).map((r) => r.stationId!),
  );
  const seen = new Set<number>();
  const chargers: ChargerView[] = [];
  for (const s of stations.data) {
    const r = byStation.get(s.id) ?? null;
    if (!r && removed.has(s.id)) continue;
    seen.add(s.id);
    chargers.push(view(r, s, sites));
  }
  // Records without a station yet, or whose station is gone from Ivora (unless the
  // list stopped early, when it may just not have been read).
  for (const r of active)
    if (!r.stationId) chargers.push(view(r, null, sites));
    else if (!seen.has(r.stationId) && !stations.truncated)
      chargers.push(view(r, null, sites, true));
  chargers.sort(
    (a, b) =>
      Number(b.pending) - Number(a.pending) || a.label.localeCompare(b.label),
  );
  return {
    ok: true,
    chargers,
    sites: [...locations.data].sort((a, b) => a.name.localeCompare(b.name)),
    truncated: stations.truncated || locations.truncated,
  };
}

/** One charger by its key (record ID or `station-<id>`), or null. */
export async function loadCharger(
  d: ChargerDeps,
  staff: Staff,
  key: string,
): Promise<
  | { ok: true; charger: ChargerView | null; sites: Location[] }
  | { ok: false; error: string }
> {
  const all = await loadChargers(d, staff);
  if (!all.ok) return all;
  return {
    ok: true,
    charger:
      all.chargers.find(
        (c) =>
          c.key === key ||
          (c.stationId !== null && key === `station-${c.stationId}`),
      ) ?? null,
    sites: all.sites,
  };
}

// ---- The kit's record ----

async function record(
  d: ChargerDeps,
  actor: Staff,
  id: string,
): Promise<ChargerRecord> {
  const r = (await d.store.list(actor.operatorId)).find(
    (x) => x.id === id && !x.removedAt,
  );
  if (!r) throw notFound();
  return r;
}

/**
 * The kit's record for a charger key. A station that is in Ivora but not yet in the
 * kit (added elsewhere) gets a record first, so tests, codes and edits have one.
 */
export async function ensureRecord(
  d: ChargerDeps,
  actor: Staff,
  key: string,
): Promise<ChargerRecord> {
  requireTechnician(actor);
  const m = /^station-(\d{1,15})$/.exec(key);
  if (!m) return record(d, actor, key);
  const stationId = Number(m[1]);
  const find = async () =>
    (await d.store.list(actor.operatorId)).find(
      (r) => r.stationId === stationId && !r.removedAt,
    );
  const existing = await find();
  if (existing) return existing;
  const s = await d.ivora.getStation(stationId);
  try {
    await d.store.create(actor, {
      name: s.name,
      label: null,
      locationId: s.location_id ?? null,
      newSite: null,
      connectors: Math.min(8, Math.max(1, s.connectors.length)),
      stationId: s.id,
      connectionUrl: s.connection_url ?? null,
    });
  } catch (e) {
    // Someone else took it over at the same moment: use theirs.
    if (!(e instanceof ChargerError && e.code === "exists")) throw e;
  }
  const created = await find();
  if (!created) throw notFound();
  return created;
}

// ---- Adding a charger ----

export interface AddResult {
  charger: ChargerRecord;
  /** Shown once, to the person who added the charger. Never stored. */
  password: string | null;
  connectionUrl: string | null;
  username: string | null;
}

/**
 * Adds a charger: our record first, then (with keys derived from it) the site if it
 * is new, the station, and a random charger password. If a step fails with an
 * uncertain outcome the record stays pending, and "Finish adding" repeats the same
 * steps with the same keys, so nothing is created twice.
 */
export async function addCharger(
  d: ChargerDeps,
  actor: Staff,
  raw: Record<string, unknown>,
): Promise<AddResult> {
  requireTechnician(actor);
  const input = parse(addChargerInput, raw);
  const id = await d.store.create(actor, {
    name: input.name,
    label: input.label,
    locationId: input.locationId,
    newSite: input.newSite,
    connectors: input.connectors,
    stationId: null,
    connectionUrl: null,
  });
  return finishAdding(d, actor, id);
}

export async function finishAdding(
  d: ChargerDeps,
  actor: Staff,
  id: string,
): Promise<AddResult> {
  requireTechnician(actor);
  const r = await record(d, actor, id);
  if (r.locationId === null) {
    if (!r.newSite) throw new ChargerError("invalid", "Choose a site.");
    let location: Location;
    try {
      location = await d.ivora.createLocation(
        {
          name: r.newSite.name,
          address: r.newSite.address,
          city: r.newSite.city,
          postal_code: r.newSite.postalCode,
          country: r.newSite.country,
          external_reference: siteReference(r.id),
        },
        idempotencyKey("site", r.id, "create"),
      );
    } catch (e) {
      // Refused outright: nothing exists in Ivora under this record yet.
      if (definitelyFailed(e)) await d.store.remove(actor, r.id);
      throw e;
    }
    r.locationId = location.id;
    r.newSite = null;
    await d.store.update(actor, r.id, {
      locationId: r.locationId,
      newSite: null,
    });
  }
  if (r.stationId === null) {
    let station: Station;
    try {
      station = await d.ivora.createStation(
        {
          name: r.name,
          location_id: r.locationId,
          connectors: r.connectors,
          external_reference: chargerReference(r.id),
        },
        idempotencyKey("charger", r.id, "create"),
      );
    } catch (e) {
      // Refused outright (for example the name is taken): nothing exists in Ivora
      // under this record, so it goes, and the form can be sent again.
      if (definitelyFailed(e)) await d.store.remove(actor, r.id);
      throw e;
    }
    r.stationId = station.id;
    r.connectionUrl = station.connection_url ?? null;
    await d.store.update(actor, r.id, {
      stationId: r.stationId,
      connectionUrl: r.connectionUrl,
    });
  }
  const password = r.passwordSetAt ? null : await setPassword(d, actor, r);
  const s = await d.ivora.getStation(r.stationId).catch(() => null);
  return {
    charger: await record(d, actor, r.id),
    password,
    connectionUrl: s?.connection_url ?? r.connectionUrl,
    username: s?.username ?? s?.name ?? r.name,
  };
}

/** What to tell staff when Ivora would not set a password. */
function credentialsError(e: unknown): unknown {
  if (!(e instanceof IvoraError)) return e;
  if (e.code === "station_online")
    return new ChargerError(
      "busy",
      "This charger is connected over OCPP 1.6, so Ivora can't change its password while it is online. Disconnect it (or switch it off) and set a new password before it reconnects, or change the password in the charger's own settings first.",
    );
  if (e.status === 429) {
    const minutes = e.retryAfterSeconds
      ? Math.max(1, Math.ceil(e.retryAfterSeconds / 60))
      : null;
    return new ChargerError(
      "busy",
      `Ivora limits how often a charger's password can change.${minutes ? ` Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` : " Try again later."} (${e.code})`,
    );
  }
  return e;
}

/**
 * Sets a new random password on the station (`PUT /credentials`). An offline station
 * stores it for its next connection; a connected OCPP 2.x station receives it. The
 * password is returned once and never stored or logged.
 */
async function setPassword(
  d: ChargerDeps,
  actor: Staff,
  r: ChargerRecord,
): Promise<string> {
  const n = await d.store.nextSeq(actor, r.id, "credentials");
  const password = generatePassword();
  let op: Operation;
  try {
    op = await settle(
      d,
      await d.ivora.setCredentials(
        r.stationId!,
        password,
        idempotencyKey("credentials", r.id, `set-${n}`),
      ),
    );
  } catch (e) {
    logIvora("charger password", e);
    throw credentialsError(e);
  }
  if (op.status === "rejected") {
    const { code, message } = rejection(op);
    throw credentialsError(new IvoraError(409, code, message));
  }
  if (op.status !== "succeeded")
    throw new ChargerError(
      "unconfirmed",
      "Ivora has not confirmed the new password yet. Set a new password before the charger connects.",
    );
  await d.store.update(actor, r.id, {
    passwordSetAt: new Date(nowOf(d)).toISOString(),
  });
  return password;
}

/** A new charger password, for example before reconnecting a charger. */
export async function resetPassword(
  d: ChargerDeps,
  actor: Staff,
  key: string,
): Promise<AddResult> {
  const r = await ensureRecord(d, actor, key);
  if (!r.stationId)
    throw new ChargerError("not_ready", "Finish adding the charger first.");
  const password = await setPassword(d, actor, r);
  const s = await d.ivora.getStation(r.stationId).catch(() => null);
  return {
    charger: r,
    password,
    connectionUrl: s?.connection_url ?? r.connectionUrl,
    username: s?.username ?? s?.name ?? r.name,
  };
}

// ---- Tests ----

/**
 * The connection test: online, booted (it sent a BootNotification) and a recent
 * heartbeat. Reads only: nothing is sent to the charger.
 */
export async function testConnection(
  d: ChargerDeps,
  actor: Staff,
  key: string,
): Promise<ConnectionTest> {
  const r = await ensureRecord(d, actor, key);
  if (!r.stationId)
    throw new ChargerError("not_ready", "Finish adding the charger first.");
  const s = await d.ivora.getStation(r.stationId);
  const now = nowOf(d);
  const seen = s.last_seen ? Date.parse(s.last_seen) : NaN;
  const test: ConnectionTest = {
    at: new Date(now).toISOString(),
    online: s.online,
    booted: Boolean(s.vendor || s.model),
    heartbeat:
      s.online &&
      Number.isFinite(seen) &&
      now - seen <= HEARTBEAT_FRESH_SECONDS * 1000,
    lastSeen: s.last_seen ?? null,
    passed: false,
  };
  test.passed = test.online && test.booted && test.heartbeat;
  await d.store.update(actor, r.id, { connectionTest: test });
  return test;
}

const running = (t: RemoteTest | null) =>
  t?.phase === "starting" || t?.phase === "charging" || t?.phase === "stopping";

/**
 * The remote test: starts a session on one connector with an operator command (no
 * payment), so the charger switches on. The caller must have confirmed that.
 */
export async function startTest(
  d: ChargerDeps,
  actor: Staff,
  key: string,
  raw: { connector: unknown; confirmed: boolean },
): Promise<RemoteTest> {
  requireTechnician(actor);
  if (!raw.confirmed)
    throw new ChargerError(
      "invalid",
      "Tick the box to confirm: this starts the charger.",
    );
  const number = parse(connectorNumber, raw.connector);
  const r = await ensureRecord(d, actor, key);
  if (!r.stationId)
    throw new ChargerError("not_ready", "Finish adding the charger first.");
  if (running(r.remoteTest))
    throw new ChargerError(
      "busy",
      "A test is already running on this charger. Check it or stop it first.",
    );
  const s = await d.ivora.getStation(r.stationId);
  if (!s.online)
    throw new ChargerError(
      "not_ready",
      "The charger is offline. Run the connection test once it is connected.",
    );
  const c = s.connectors.find((x, i) => (x.number ?? i + 1) === number);
  if (!c) throw new ChargerError("invalid", "Choose a connector.");
  const attempt = await d.store.nextSeq(actor, r.id, "test");
  const test: RemoteTest = {
    attempt,
    phase: "starting",
    connectorNumber: number,
    connectorId: c.id,
    requestedAt: new Date(nowOf(d)).toISOString(),
    transactionId: null,
    operationId: null,
    energyWh: 0,
    finishedAt: null,
    error: null,
  };
  try {
    const op = await settle(
      d,
      await d.ivora.sendCommand(
        r.stationId,
        {
          action: "start",
          connector_id: c.id,
          token: TEST_TOKEN,
          token_type: "Central",
        },
        idempotencyKey("charger", r.id, `test-${attempt}-start`),
      ),
    );
    applyAnswer(test, op, "start");
  } catch (e) {
    logIvora("test start", e);
    test.phase = "failed";
    test.error = describeError(e);
  }
  await d.store.update(actor, r.id, { remoteTest: test });
  return running(test) ? checkTest(d, actor, r.id) : test;
}

function applyAnswer(t: RemoteTest, op: Operation, what: "start" | "stop") {
  t.operationId = op.status === "dispatching" ? op.id : null;
  if (op.status === "rejected") {
    const { code, message } = rejection(op);
    t.phase = "failed";
    t.error = `Ivora refused the ${what} (${code}): ${message}.`;
    return;
  }
  const answer = chargerStatus(op);
  if (answer && answer !== "Accepted") {
    t.phase = "failed";
    t.error = `The charger answered ${answer} to the ${what}. ${what === "start" ? "Check the connector is free (some chargers need a vehicle plugged in)." : "Stop the session at the charger."}`;
  }
}

/** Reads the test session's progress from Ivora and records it. */
export async function checkTest(
  d: ChargerDeps,
  actor: Staff,
  key: string,
): Promise<RemoteTest> {
  const r = await ensureRecord(d, actor, key);
  const t = r.remoteTest;
  if (!t || !running(t) || !r.stationId)
    throw new ChargerError("not_ready", "No test is running.");
  if (t.operationId) {
    const op = await d.ivora.getOperation(t.operationId);
    applyAnswer(t, op, t.phase === "stopping" ? "stop" : "start");
  }
  if (running(t)) {
    const tx = await findTransaction(d, r.stationId, t);
    if (tx) {
      t.transactionId = tx.id;
      t.energyWh = tx.energy_wh ?? 0;
      if (t.phase === "starting") t.phase = "charging";
      // Started and stopped cleanly: the charger accepted the remote start and stop
      // and reported the session. Energy is 0 if no vehicle was plugged in.
      if (tx.active === false || (tx.active === null && tx.ended_at)) {
        t.phase = "passed";
        t.finishedAt = tx.ended_at ?? new Date(nowOf(d)).toISOString();
      }
    } else if (nowOf(d) - Date.parse(t.requestedAt) > TEST_TIMEOUT_MS) {
      t.phase = "failed";
      t.error =
        "The charger did not report a session within 2 minutes. Check it accepts remote starts (some need a vehicle plugged in).";
    }
  }
  await d.store.update(actor, r.id, { remoteTest: t });
  return t;
}

async function findTransaction(
  d: ChargerDeps,
  stationId: number,
  t: RemoteTest,
): Promise<Transaction | null> {
  if (t.transactionId) return d.ivora.getTransaction(t.transactionId);
  const since = Date.parse(t.requestedAt) - 60_000;
  const list = await d.ivora.listTransactions({
    station_id: stationId,
    limit: 10,
  });
  return (
    list.find(
      (x) =>
        (x.connector_id == null || x.connector_id === t.connectorId) &&
        Date.parse(x.started_at ?? "") >= since,
    ) ?? null
  );
}

/** Stops the test session (`stop` command with its transaction). */
export async function stopTest(
  d: ChargerDeps,
  actor: Staff,
  key: string,
): Promise<RemoteTest> {
  let t = await checkTest(d, actor, key);
  const r = await ensureRecord(d, actor, key);
  if (!running(t)) return t;
  if (!t.transactionId)
    throw new ChargerError(
      "not_ready",
      "The charger has not reported the session yet. Wait a moment and check again.",
    );
  if (t.phase !== "stopping") {
    try {
      const op = await settle(
        d,
        await d.ivora.sendCommand(
          r.stationId!,
          { action: "stop", transaction_id: t.transactionId },
          idempotencyKey("charger", r.id, `test-${t.attempt}-stop`),
        ),
      );
      t.phase = "stopping";
      applyAnswer(t, op, "stop");
    } catch (e) {
      logIvora("test stop", e);
      // Stays running: staff can try again (same key) or stop it at the charger.
      throw e;
    }
    await d.store.update(actor, r.id, { remoteTest: t });
  }
  t = await checkTest(d, actor, key);
  return t;
}

/** Energy of a test, for display. */
export const testEnergyKwh = (t: RemoteTest) => whToKwh(t.energyWh);

// ---- Editing and removing ----

/** Changes the kit's display name, and moves the station to another site in Ivora. */
export async function editCharger(
  d: ChargerDeps,
  actor: Staff,
  key: string,
  raw: Record<string, unknown>,
): Promise<void> {
  requireTechnician(actor);
  const input = parse(editChargerInput, raw);
  const r = await ensureRecord(d, actor, key);
  if (!r.stationId)
    throw new ChargerError("not_ready", "Finish adding the charger first.");
  if (input.locationId !== r.locationId) {
    const n = await d.store.nextSeq(actor, r.id, "edit");
    let op: Operation;
    try {
      op = await settle(
        d,
        await d.ivora.updateStation(
          r.stationId,
          { location_id: input.locationId },
          idempotencyKey("charger", r.id, `move-${n}`),
        ),
      );
    } catch (e) {
      logIvora("charger move", e);
      throw e;
    }
    if (op.status === "rejected") {
      const { code, message } = rejection(op);
      throw new IvoraError(409, code, message);
    }
  }
  await d.store.update(actor, r.id, {
    label: input.label,
    locationId: input.locationId,
  });
}

export interface RemoveResult {
  /** Ivora deleted the station; false when it keeps it (charging history). */
  deletedInIvora: boolean;
}

/**
 * Removes a charger. Ivora deletes a station that never charged (disconnecting it
 * first if needed); one with charging history stays in Ivora, and the kit hides it.
 * Either way its sticker codes stop leading to it. Managers and owners only, except
 * for a charger the kit never registered in Ivora.
 */
export async function removeCharger(
  d: ChargerDeps,
  actor: Staff,
  key: string,
  confirmed: boolean,
): Promise<RemoveResult> {
  requireTechnician(actor);
  if (!confirmed)
    throw new ChargerError(
      "invalid",
      "Tick the box to confirm you want to remove this charger.",
    );
  const r = await ensureRecord(d, actor, key);
  if (r.stationId && !atLeast(actor.role, "manager"))
    throw notAllowed("remove chargers (managers and owners can)");
  let deletedInIvora = false;
  if (r.stationId) {
    try {
      await d.ivora.deleteStation(
        r.stationId,
        idempotencyKey("charger", r.id, "delete"),
      );
      deletedInIvora = true;
    } catch (e) {
      if (!(e instanceof IvoraError)) throw e;
      if (e.code === "transaction_active")
        throw new ChargerError(
          "busy",
          "A session is running on this charger. Stop it first, then remove the charger.",
        );
      if (e.code === "station_not_found") deletedInIvora = true;
      else if (e.code !== "station_has_history") {
        logIvora("charger delete", e);
        throw e;
      }
    }
  }
  await d.store.remove(actor, r.id);
  return { deletedInIvora };
}

// ---- Stickers ----

/** Gives every connector a stable sticker code (codes already given stay). */
export async function prepareStickers(
  d: ChargerDeps,
  actor: Staff,
  key: string,
): Promise<ChargerRecord> {
  let r = await ensureRecord(d, actor, key);
  if (!r.stationId)
    throw new ChargerError("not_ready", "Finish adding the charger first.");
  const s = await d.ivora.getStation(r.stationId);
  const wanted = s.connectors.map((c, i) => ({
    connectorNumber: c.number ?? i + 1,
    connectorId: c.id,
  }));
  if (!wanted.length)
    throw new ChargerError(
      "not_ready",
      "Ivora reports no connectors for this charger yet.",
    );
  // A drawn code may already be taken (very unlikely): draw again for those.
  for (let round = 0; round < 3; round++) {
    const have = new Set(r.codes.map((c) => c.connectorNumber));
    const missing = wanted.filter((w) => !have.has(w.connectorNumber));
    if (!missing.length) return r;
    await d.store.addCodes(
      actor,
      r.id,
      missing.map((w) => ({ ...w, code: newStickerCode() })),
    );
    r = await record(d, actor, r.id);
  }
  throw new ChargerError("busy", "Could not create sticker codes. Try again.");
}
