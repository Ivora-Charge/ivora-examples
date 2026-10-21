import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Backend } from "./backend";
import { isDemo, liveConfig } from "./config";
import { demoBackend } from "./demo-backend";
import { HttpError, IvoraError } from "./errors";
import { publicError, type PublicError } from "./http";
import { IvoraClient, liveBackend } from "./ivora";
import { db } from "./store";
import { newStickerCode } from "../codes";
import { firstDisplay, generatePassword, maskSecret } from "../credentials";
import { mapEvent } from "../status";
import type { Charger, ConfigKey, Site, TestRun } from "../types";

let override: Backend | null = null;

/** The one place that decides between demo and live. */
export function backend(): Backend {
  if (override) return override;
  return isDemo() ? demoBackend : liveBackend(new IvoraClient(liveConfig()));
}

export function setBackendForTests(b: Backend | null) {
  override = b;
}

const notFound = () => new HttpError(404, "not_found", "Charger not found.");

function charger(id: string): Charger {
  const c = db().chargers.get(id);
  if (!c) throw notFound();
  return c;
}

// ---- Sites ----

export const siteInput = z.object({
  name: z.string().trim().min(1).max(80),
  address: z.string().trim().min(1).max(120),
  city: z.string().trim().max(120).default(""),
  state: z.string().trim().max(120).default(""),
  postalCode: z.string().trim().max(20).default(""),
  country: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, "Use a three-letter country code such as USA.")
    .default("USA"),
});

export async function listSites() {
  return {
    sites: [...db().sites.values()],
    locations: await backend().listLocations(),
  };
}

export async function createSite(raw: unknown): Promise<Site> {
  const input = siteInput.parse(raw);
  const id = randomUUID();
  const draft: Site = { id, locationId: "", ...input };
  const locationId = await backend().createLocation(draft, `${id}:location`);
  const site = { ...draft, locationId };
  db().sites.set(id, site);
  return site;
}

/** Use a location that already exists in Ivora instead of creating one. */
export async function pickLocation(locationId: string): Promise<Site> {
  const existing = [...db().sites.values()].find(
    (s) => s.locationId === locationId,
  );
  if (existing) return existing;
  const location = (await backend().listLocations()).find(
    (l) => l.locationId === locationId,
  );
  if (!location)
    throw new HttpError(404, "not_found", "That location was not found.");
  const site: Site = {
    id: randomUUID(),
    locationId,
    name: location.name,
    address: location.address,
    city: "",
    state: "",
    postalCode: "",
    country: "USA",
  };
  db().sites.set(site.id, site);
  return site;
}

// ---- Chargers and credentials ----

export const chargerInput = z.object({
  siteId: z.string().min(1),
  name: z
    .string()
    .trim()
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,35}$/,
      "Use 3-36 letters, digits, - or _, starting with a letter or digit.",
    ),
  connectors: z.coerce.number().int().min(1).max(8).default(1),
});

export type AddChargerResult = {
  charger: Charger;
  /** Shown once; null if Ivora could not confirm it. */
  password: string | null;
  passwordError?: PublicError;
};

export async function addCharger(raw: unknown): Promise<AddChargerResult> {
  const input = chargerInput.parse(raw);
  const site = db().sites.get(input.siteId);
  if (!site)
    throw new HttpError(404, "not_found", "Pick or create a site first.");
  const b = backend();
  const id = randomUUID();
  const station = await b.createStation({
    key: `${id}:station`,
    reference: `installer-kit:charger:${id}`,
    name: input.name,
    locationId: site.locationId,
    connectors: input.connectors,
  });
  const now = new Date().toISOString();
  const c: Charger = {
    id,
    siteId: site.id,
    name: input.name,
    stationId: station.stationId,
    connectionUrl: station.connectionUrl,
    username: station.username,
    createdAt: now,
    demo: b.demo,
    passwordMasked: maskSecret(""),
    passwordSet: false,
    state: "waiting",
    lastChangeAt: now,
    connectors: [],
    seq: { credentials: 0, test: 0, config: 0 },
  };
  db().chargers.set(id, c);
  try {
    return { charger: c, password: await newPassword(c) };
  } catch (e) {
    return { charger: c, password: null, passwordError: publicError(e).body };
  }
}

/** Set a fresh password on the station. Returned once, never stored in plain text. */
async function newPassword(c: Charger): Promise<string> {
  c.seq.credentials += 1;
  const password = generatePassword();
  c.passwordSet = false;
  await backend().setPassword(
    c.stationId,
    password,
    `${c.id}:credentials:${c.seq.credentials}`,
  );
  c.passwordSet = true;
  c.passwordMasked = firstDisplay(password).masked;
  return password;
}

export async function rotatePassword(id: string) {
  const c = charger(id);
  return { charger: c, password: await newPassword(c) };
}

// ---- Connection status ----

function assignStickerCodes(c: Charger) {
  for (const k of c.connectors) {
    if (k.code) continue;
    let code = newStickerCode();
    while (db().codes.has(code)) code = newStickerCode();
    k.code = code;
    db().codes.set(code, { chargerId: c.id, connectorNumber: k.number });
  }
}

/** Read the current state from the API (webhooks only nudge it sooner). */
export async function refresh(id: string): Promise<Charger> {
  const c = charger(id);
  const b = backend();
  const s = await b.getStation(c.stationId);
  if (s.state !== c.state) c.lastChangeAt = new Date().toISOString();
  c.state = s.state;
  if (s.boot)
    c.boot = {
      ...s.boot,
      firmware: s.boot.firmware ?? c.boot?.firmware ?? null,
    };
  for (const k of s.connectors) {
    const known = c.connectors.find((x) => x.number === k.number);
    if (known) {
      known.resourceId = k.resourceId;
      known.status = k.status;
    } else c.connectors.push({ ...k });
  }
  c.connectors.sort((x, y) => x.number - y.number);
  assignStickerCodes(c);
  if (c.test) await advanceTest(c, b);
  return c;
}

type IvoraEvent = {
  id: string;
  type: string;
  tenant_id?: number;
  station_id?: number | string | null;
  resource_id?: string | null;
  data?: Record<string, unknown>;
};

/** Apply a verified, deduplicated webhook event. Unknown stations are ignored. */
export function applyEvent(event: IvoraEvent) {
  const state = mapEvent(event.type);
  if (!state) return false;
  const stationId = String(event.station_id ?? event.resource_id ?? "");
  const c = [...db().chargers.values()].find((x) => x.stationId === stationId);
  if (!c) return false;
  c.state = state;
  c.lastChangeAt = new Date().toISOString();
  if (state === "booted") {
    const d = event.data ?? {};
    const text = (v: unknown) => (typeof v === "string" ? v : null);
    c.boot = {
      vendor: text(d.vendor) ?? c.boot?.vendor ?? null,
      model: text(d.model) ?? c.boot?.model ?? null,
      firmware: text(d.firmware_version) ?? c.boot?.firmware ?? null,
    };
  }
  return true;
}

// ---- Test session ----

const TEST_TIMEOUT_MS = 2 * 60_000;
const inProgress = (t?: TestRun) =>
  t &&
  (t.phase === "starting" || t.phase === "charging" || t.phase === "stopping");

const inServiceError = () =>
  new HttpError(
    409,
    "in_service",
    "This charger is in service, so test sessions are no longer allowed. Use a normal charging session instead.",
  );

export async function startTest(id: string, connectorNumber?: number) {
  const c = await refresh(id);
  if (c.inServiceAt) throw inServiceError();
  if (c.state !== "booted")
    throw new HttpError(
      409,
      "not_booted",
      "Wait until the charger has booted.",
    );
  if (inProgress(c.test))
    throw new HttpError(409, "test_running", "A test is already running.");
  const connector =
    c.connectors.find((k) => k.number === connectorNumber) ?? c.connectors[0];
  if (!connector)
    throw new HttpError(
      409,
      "no_connector",
      "The charger reported no connectors.",
    );
  // Free means nothing is charging there: no active session from anyone, and
  // a status that is Available or Preparing (a plugged-in vehicle) if known.
  const b = backend();
  const status = connector.status?.toLowerCase();
  if (
    (status && status !== "available" && status !== "preparing") ||
    (await b.hasActiveTransaction(c.stationId, connector.resourceId))
  )
    throw new HttpError(
      409,
      "connector_busy",
      "That connector is not free. Wait until it is available, or pick another.",
    );
  // Nothing may be awaited between this check and setting the test, or two
  // starts could both pass it, or one could start after Mark in service.
  if (c.inServiceAt) throw inServiceError();
  if (inProgress(c.test))
    throw new HttpError(409, "test_running", "A test is already running.");
  const attempt = c.seq.test + 1;
  c.seq.test = attempt;
  const test: TestRun = {
    attempt,
    phase: "starting",
    connectorNumber: connector.number,
    requestedAt: new Date().toISOString(),
    energyWh: 0,
  };
  c.test = test;
  try {
    await b.startCharging(
      c.stationId,
      connector.resourceId,
      `${c.id}:test:${attempt}:start`,
    );
  } catch (e) {
    // Only a definite refusal ends the test. After a timeout, outcome_unknown
    // or request_in_progress the command may have reached the charger, so the
    // test stays at "starting": the refresh adopts the session or times out,
    // and Stop can end it.
    if (isRefusal(e)) {
      test.phase = "failed";
      test.passed = false;
      test.errorCode = publicError(e).body.error;
    }
    throw e;
  }
  return refresh(id);
}

/** The charger or Ivora answered that the start was not carried out. */
function isRefusal(e: unknown) {
  return (
    (e instanceof IvoraError && e.refused) ||
    (e instanceof HttpError && e.code === "start_not_accepted")
  );
}

/** Record that the charger is handed over. Repeating it keeps the first time. */
export function markInService(id: string): Charger {
  const c = charger(id);
  if (c.inServiceAt) return c;
  if (inProgress(c.test))
    throw new HttpError(
      409,
      "test_running",
      "Stop the test session before marking the charger in service.",
    );
  c.inServiceAt = new Date().toISOString();
  return c;
}

export async function stopTest(id: string) {
  const c = await refresh(id);
  const t = c.test;
  if (!t || !inProgress(t))
    throw new HttpError(409, "no_test", "No test is running.");
  if (!t.transactionId)
    throw new HttpError(
      409,
      "not_started",
      "The charger has not reported the session yet; wait a moment.",
    );
  if (t.phase !== "stopping") {
    await backend().stopCharging(
      c.stationId,
      t.transactionId,
      `${c.id}:test:${t.attempt}:stop`,
    );
    t.phase = "stopping";
  }
  return refresh(id);
}

async function advanceTest(c: Charger, b: Backend) {
  const t = c.test!;
  if (!inProgress(t)) return;
  const connector = c.connectors.find((k) => k.number === t.connectorNumber);
  const tx = t.transactionId
    ? await b.getTransaction(t.transactionId)
    : connector
      ? await b.findTransaction(
          c.stationId,
          connector.resourceId,
          t.requestedAt,
        )
      : null;
  const waited = Date.now() - Date.parse(t.requestedAt);
  if (!tx) {
    if (waited > TEST_TIMEOUT_MS) {
      t.phase = "failed";
      t.passed = false;
      t.errorCode = "no_transaction";
    }
    return;
  }
  t.transactionId = tx.transactionId;
  t.startedAt = tx.startedAt ?? t.startedAt;
  t.energyWh = tx.energyWh;
  if (t.phase === "starting") t.phase = "charging";
  if (!tx.active) {
    // Started and stopped cleanly: the charger accepted remote start/stop and
    // reported a transaction. Energy is 0 if no vehicle was plugged in.
    t.phase = "done";
    t.passed = true;
    t.finishedAt = tx.endedAt ?? new Date().toISOString();
  }
}

// ---- Configuration ----

export const CONFIG_KEYS: ConfigKey[] = [
  "HeartbeatInterval",
  "MeterValueSampleInterval",
];

export async function readConfig(id: string) {
  const c = charger(id);
  c.seq.config += 1;
  const values = await backend().readConfiguration(
    c.stationId,
    CONFIG_KEYS,
    `${c.id}:config-read:${c.seq.config}`,
  );
  c.config = { readAt: new Date().toISOString(), values };
  return c;
}

export const configChange = z.object({
  key: z.enum(["HeartbeatInterval", "MeterValueSampleInterval"]),
  value: z.coerce.number().int().min(10).max(86_400),
});

/** Change one interval, then read the configuration back to confirm it. */
export async function changeConfig(id: string, raw: unknown) {
  const { key, value } = configChange.parse(raw);
  const c = charger(id);
  c.seq.config += 1;
  const chargerStatus = await backend().changeConfiguration(
    c.stationId,
    key,
    String(value),
    `${c.id}:config-change:${c.seq.config}`,
  );
  await readConfig(id);
  return { charger: c, chargerStatus };
}

// ---- Tariff, stickers and report ----

export async function setTariff(id: string, raw: unknown) {
  const { centsPerKwh } = z
    .object({ centsPerKwh: z.coerce.number().int().min(0).max(10_000) })
    .parse(raw);
  const c = charger(id);
  c.tariffCentsPerKwh = centsPerKwh;
  return c;
}

export function chargerWithSite(id: string) {
  const c = charger(id);
  const site = db().sites.get(c.siteId);
  if (!site) throw notFound();
  return { charger: c, site };
}

export function resolveStickerCode(code: string) {
  const entry = db().codes.get(code);
  if (!entry) return null;
  const c = db().chargers.get(entry.chargerId);
  const site = c && db().sites.get(c.siteId);
  if (!c || !site) return null;
  return { charger: c, site, connectorNumber: entry.connectorNumber };
}
