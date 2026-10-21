import "server-only";
import type { z } from "zod";
import type { QuotePreview } from "@/lib/action-state";
import {
  formatMinor,
  formatMinorDecimal,
  minorToMajorString,
} from "@/lib/money";
import { atLeast } from "@/lib/roles";
import {
  describeError,
  idempotencyKey,
  IvoraError,
  tariffProblems,
  type IvoraClient,
  type Quote,
  type SessionProfile,
} from "../ivora";
import type { OnboardingStore } from "../onboarding/types";
import type { Staff } from "../team/types";
import {
  simulationSchema,
  tariffFormSchema,
  type Simulation,
  type SimulationForm,
  type TariffForm,
} from "./input";
import {
  DEFAULT_IDLE_GRACE_MINUTES,
  definitionInput,
  describeDays,
  driverText,
  summary,
  tariffInput,
} from "./tariff";
import { localDate, minutesBetween, zonedToUtc } from "./time";
import {
  busy,
  notAllowed,
  notFound,
  PricingError,
  type KitTariff,
  type PricingState,
  type PricingStore,
  type StationPricing,
  type TariffDefinition,
  type TariffVersion,
} from "./types";

// Pricing rules, shared by demo and live mode. Owners and managers only: every
// function that changes something checks the role here, on the server, and the store
// checks it again in the same statement as the write. Prices are never computed by the
// kit: previews are Ivora's simulation (POST /tariffs/simulate), the calculation bills
// finalize with. Logs carry error codes and request IDs only.

export interface PricingDeps {
  store: PricingStore;
  ivora: IvoraClient;
  /** The company profile: a new tariff's currency and time zone. */
  company: Pick<OnboardingStore, "load">;
}

function requireManager(actor: Staff) {
  if (!atLeast(actor.role, "manager")) throw notAllowed();
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new PricingError(
      "invalid",
      r.error.issues[0]?.message ?? "Check the form and try again.",
      r.error.issues.slice(1).map((i) => i.message),
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

/** The API refused outright: nothing was created, so the version can go. */
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

const ivoraRefusal = (e: unknown) =>
  new PricingError("invalid", describeError(e), tariffProblems(e));

// ---- Reading ----

/** The version drivers are billed with: the newest one Ivora has. */
export const currentVersion = (t: KitTariff): TariffVersion | null =>
  t.versions.find((v) => v.ivoraTariffId !== null) ?? null;

/** A newer version whose creation in Ivora is not confirmed yet. */
export function pendingVersion(t: KitTariff): TariffVersion | null {
  const v = t.versions[0];
  return v && v.ivoraTariffId === null ? v : null;
}

/** Older versions whose Ivora tariff is not archived yet. */
const unarchived = (t: KitTariff) => {
  const current = currentVersion(t);
  return t.versions.filter(
    (v) =>
      current &&
      v.version < current.version &&
      v.ivoraTariffId !== null &&
      !v.archivedAt,
  );
};

export interface EffectiveTariff {
  tariff: KitTariff;
  version: TariffVersion;
  /** Where it comes from: the connector's own assignment, or its station's. */
  source: "connector" | "station";
}

/** A connector's tariff: its own assignment, else its station's; null for none. */
export function effectiveTariff(
  state: PricingState,
  stationId: number,
  connectorId: number,
): EffectiveTariff | null {
  const sp = state.stations.find((s) => s.stationId === stationId);
  if (!sp) return null;
  const own = sp.connectors[String(connectorId)];
  const id = own ?? sp.tariffId;
  const tariff = id ? state.tariffs.find((t) => t.id === id) : undefined;
  const version = tariff ? currentVersion(tariff) : null;
  if (!tariff || !version) return null;
  return { tariff, version, source: own ? "connector" : "station" };
}

export interface ConnectorPricing {
  /** No public QR checkout: staff and RFID only. */
  private: boolean;
  tariff: {
    name: string;
    version: number;
    /** The Ivora tariff a bill for this connector snapshots. */
    ivoraTariffId: number;
    free: boolean;
    driverText: string | null;
  } | null;
}

/**
 * What a driver at this connector pays, and whether the public checkout is open. The
 * QR page reads it now; the driver payment flow (a later part) bills with
 * `ivoraTariffId`.
 */
export async function connectorPricing(
  store: PricingStore,
  operatorId: string,
  stationId: number,
  connectorId: number | null,
): Promise<ConnectorPricing> {
  const state = await store.load(operatorId);
  const sp = state.stations.find((s) => s.stationId === stationId);
  const e =
    connectorId === null
      ? null
      : effectiveTariff(state, stationId, connectorId);
  const def = e?.version.definition ?? null;
  return {
    private: Boolean(sp?.private),
    tariff: e
      ? {
          name: e.tariff.name,
          version: e.version.version,
          ivoraTariffId: e.version.ivoraTariffId!,
          free: def?.kind === "free",
          driverText: def ? driverText(def) : null,
        }
      : null,
  };
}

/** For the setup checklist: tariffs live in Ivora, and chargers that have one. */
export async function pricingProgress(
  store: PricingStore,
  operatorId: string,
): Promise<{ tariffs: number; assigned: number }> {
  const state = await store.load(operatorId);
  const live = new Set(
    state.tariffs.filter((t) => currentVersion(t)).map((t) => t.id),
  );
  return {
    tariffs: live.size,
    assigned: state.stations.filter(
      (s) =>
        (s.tariffId && live.has(s.tariffId)) ||
        Object.values(s.connectors).some((id) => live.has(id)),
    ).length,
  };
}

export interface TariffView {
  id: string;
  name: string;
  current: TariffVersion | null;
  pending: TariffVersion | null;
  /** The definition the editor starts from: the pending one, else the current one. */
  definition: TariffDefinition | null;
  summary: string;
  driverText: string | null;
  versions: TariffVersion[];
  /** Older versions Ivora still has active (an archive did not go through yet). */
  needsFinishing: boolean;
  /** Connectors that use it now. */
  connectors: number;
}

export interface ConnectorPricingView {
  id: number;
  number: number;
  /** The connector's own assignment, if any. */
  override: string | null;
  /** What it uses: its own, its station's, or nothing. */
  tariffId: string | null;
  tariffName: string | null;
  source: "connector" | "station" | null;
  /** The tariff Ivora has on the connector (charger screens show its price). */
  ivoraTariffId: number | null;
}

export interface StationPricingView {
  stationId: number;
  name: string;
  siteName: string | null;
  private: boolean;
  tariffId: string | null;
  connectors: ConnectorPricingView[];
}

export interface PricingView {
  tariffs: TariffView[];
  stations: StationPricingView[];
  /** The stations could not be read from Ivora (tariffs still show). */
  stationsError: string | null;
  truncated: boolean;
  currency: string;
  timeZone: string;
}

function tariffView(t: KitTariff, uses: number): TariffView {
  const current = currentVersion(t);
  const pending = pendingVersion(t);
  const definition = pending?.definition ?? current?.definition ?? null;
  return {
    id: t.id,
    name: t.name,
    current,
    pending,
    definition,
    summary: definition ? summary(definition) : "",
    driverText: current?.definition ? driverText(current.definition) : null,
    versions: t.versions,
    needsFinishing: Boolean(pending) || unarchived(t).length > 0,
    connectors: uses,
  };
}

/** The company's currency and time zone, the defaults of a new tariff. */
async function defaults(d: PricingDeps, operatorId: string) {
  const p = await d.company.load(operatorId);
  return { currency: p.currency ?? "USD", timeZone: p.timeZone ?? "UTC" };
}

/** Every tariff, and every station with which tariff each connector uses. */
export async function loadPricing(
  d: PricingDeps,
  staff: Staff,
): Promise<PricingView> {
  requireManager(staff);
  const [state, base] = await Promise.all([
    d.store.load(staff.operatorId),
    defaults(d, staff.operatorId),
  ]);
  let stations: StationPricingView[] = [];
  let stationsError: string | null = null;
  let truncated = false;
  const uses = new Map<string, number>();
  try {
    const [s, l] = await Promise.all([
      d.ivora.listAllStations(),
      d.ivora.listAllLocations(),
    ]);
    truncated = s.truncated || l.truncated;
    const sites = new Map(l.data.map((x) => [x.id, x.name]));
    const byStation = new Map(state.stations.map((x) => [x.stationId, x]));
    stations = s.data.map((st) => {
      const sp: StationPricing | undefined = byStation.get(st.id);
      return {
        stationId: st.id,
        name: st.name,
        siteName:
          st.location_id != null ? (sites.get(st.location_id) ?? null) : null,
        private: Boolean(sp?.private),
        tariffId: sp?.tariffId ?? null,
        connectors: st.connectors.map((c, i) => {
          const e = effectiveTariff(state, st.id, c.id);
          if (e) uses.set(e.tariff.id, (uses.get(e.tariff.id) ?? 0) + 1);
          return {
            id: c.id,
            number: c.number ?? i + 1,
            override: sp?.connectors[String(c.id)] ?? null,
            tariffId: e?.tariff.id ?? null,
            tariffName: e?.tariff.name ?? null,
            source: e?.source ?? null,
            ivoraTariffId: c.tariff_id ?? null,
          };
        }),
      };
    });
    stations.sort(
      (a, b) =>
        (a.siteName ?? "").localeCompare(b.siteName ?? "") ||
        a.name.localeCompare(b.name),
    );
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    logIvora("pricing stations read", e);
    stationsError = describeError(e);
  }
  return {
    tariffs: state.tariffs
      .map((t) => tariffView(t, uses.get(t.id) ?? 0))
      .sort((a, b) => a.name.localeCompare(b.name)),
    stations,
    stationsError,
    truncated,
    ...base,
  };
}

/** One tariff for its editor page, or null. */
export async function loadTariff(
  d: PricingDeps,
  staff: Staff,
  id: string,
): Promise<TariffView | null> {
  requireManager(staff);
  const state = await d.store.load(staff.operatorId);
  const t = state.tariffs.find((x) => x.id === id);
  return t ? tariffView(t, 0) : null;
}

/** A new tariff's starting values: the company's currency and time zone. */
export async function newTariffDefaults(d: PricingDeps, staff: Staff) {
  requireManager(staff);
  return defaults(d, staff.operatorId);
}

/** The editor's fields as text, from a definition (or a new tariff's defaults). */
export interface EditorValues {
  name: string;
  kind: "paid" | "free";
  timeZone: string;
  energy: string;
  sessionFee: string;
  idleFee: string;
  idleGrace: string;
  driverText: string;
  periods: { start: string; end: string; price: string; days: string[] }[];
}

export function editorValues(
  name: string,
  def: TariffDefinition | null,
  base: { currency: string; timeZone: string },
): EditorValues {
  if (!def)
    return {
      name,
      kind: "paid",
      timeZone: base.timeZone,
      energy: "",
      sessionFee: "",
      idleFee: "",
      idleGrace: String(DEFAULT_IDLE_GRACE_MINUTES),
      driverText: "",
      periods: [],
    };
  const m = (minor: number) =>
    minor ? minorToMajorString(minor, def.currency) : "";
  return {
    name,
    kind: def.kind,
    timeZone: def.timeZone,
    energy:
      def.kind === "paid"
        ? minorToMajorString(def.energyMinorPerKwh, def.currency)
        : "",
    sessionFee: m(def.sessionFeeMinor),
    idleFee: m(def.idleMinorPerMinute),
    idleGrace: String(
      def.idleMinorPerMinute
        ? def.idleGraceMinutes
        : DEFAULT_IDLE_GRACE_MINUTES,
    ),
    driverText: def.driverText ?? "",
    periods: def.periods.map((p) => ({
      start: p.start,
      end: p.end,
      price: minorToMajorString(p.energyMinorPerKwh, def.currency),
      days: [...p.days],
    })),
  };
}

// ---- Preview ----

export type QuoteView = QuotePreview;

/** Trailing zeros off a decimal string: "12.500000" to "12.5". */
const trim = (q: string) => q.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

/** The preview session as Ivora's session profile. The idle grace is the kit's. */
export function sessionProfile(
  def: TariffDefinition,
  s: Simulation,
): SessionProfile & { billedIdleMinutes: number } {
  const billedIdleMinutes = Math.max(0, s.idleMinutes - def.idleGraceMinutes);
  return {
    start_at: zonedToUtc(s.date, s.start, def.timeZone).toISOString(),
    time_zone: def.timeZone,
    duration_minutes: minutesBetween(s.start, s.end),
    energy_kwh: s.energyKwh,
    idle_minutes: billedIdleMinutes,
    billedIdleMinutes,
  };
}

/** Ivora's answer, laid out for staff: its amounts exactly as it returned them. */
export function quoteView(
  q: Quote,
  def: TariffDefinition,
  s: Simulation,
  demo: boolean,
): QuoteView {
  const c = q.currency;
  const billedIdle = Math.max(0, s.idleMinutes - def.idleGraceMinutes);
  const label = (type: string, element: number) => {
    if (type === "ENERGY") {
      const p = def.kind === "paid" ? def.periods[element] : undefined;
      return p
        ? `Energy, period ${element + 1} (${describeDays(p.days)} ${p.start}–${p.end})`
        : "Energy, base price";
    }
    if (type === "FLAT") return "Session fee";
    if (type === "PARKING_TIME")
      return def.idleGraceMinutes
        ? `Idle fee (${billedIdle} of ${s.idleMinutes} idle minutes; the first ${def.idleGraceMinutes} are free)`
        : "Idle fee";
    return type;
  };
  const per = { kWh: "/kWh", h: "/hour", session: "" } as const;
  const lines = q.lines.map((l) => ({
    label: label(l.type, l.element),
    quantity:
      l.unit === "h"
        ? `${trim((Number(l.quantity) * 60).toFixed(2))} min`
        : l.unit === "kWh"
          ? `${trim(l.quantity)} kWh`
          : trim(l.quantity),
    unitPrice: `${formatMinorDecimal(l.price_minor, c)}${per[l.unit] ?? ""}`,
    amount: formatMinor(l.amount_minor, c),
  }));
  const notes: string[] = [];
  if (q.lines.reduce((a, l) => a + l.amount_minor, 0) !== q.subtotal_minor)
    notes.push(
      "Lines are rounded for display; the total rounds the exact sum once, as bills do.",
    );
  if (q.lines.some((l) => l.type === "PARKING_TIME"))
    notes.push(
      "Ivora's bills do not charge idle time yet (PARKING_TIME is priced in simulations and quotes only), so drivers are not billed this idle fee for now.",
    );
  if (s.idleMinutes && billedIdle === 0 && def.idleMinorPerMinute)
    notes.push(
      `All ${s.idleMinutes} idle minutes are inside the ${def.idleGraceMinutes}-minute grace period.`,
    );
  const total = formatMinor(q.total_minor, c);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(Date.parse(`${s.date}T12:00:00Z`));
  const idle = s.idleMinutes
    ? `, then ${s.idleMinutes} idle ${s.idleMinutes === 1 ? "minute" : "minutes"}`
    : "";
  return {
    sentence: `A ${trim(String(s.energyKwh))} kWh session on ${day} from ${s.start} to ${s.end} (${def.timeZone})${idle} costs ${total}.`,
    lines,
    adjustments: q.adjustments.map((a) => ({
      label: a.kind.replaceAll("_", " "),
      amount: formatMinor(a.amount_minor, c),
    })),
    subtotal: formatMinor(q.subtotal_minor, c),
    total,
    totalMinor: q.total_minor,
    currency: c,
    driverText: q.tariff_alt_text?.[0]?.text ?? driverText(def),
    notes,
    demo,
  };
}

/** The currency a form is in: the tariff's own, or the company's for a new one. */
async function formCurrency(
  d: PricingDeps,
  actor: Staff,
  tariffId: string | null,
): Promise<{ currency: string; tariff: KitTariff | null }> {
  if (!tariffId)
    return {
      currency: (await defaults(d, actor.operatorId)).currency,
      tariff: null,
    };
  const t = (await d.store.load(actor.operatorId)).tariffs.find(
    (x) => x.id === tariffId,
  );
  if (!t) throw notFound();
  const def = pendingVersion(t)?.definition ?? currentVersion(t)?.definition;
  return { currency: def?.currency ?? "USD", tariff: t };
}

/**
 * Prices the preview session under the editor's draft with Ivora's simulation (in
 * demo mode, the demo client's offline stand-in). Ivora validates the draft as tariff
 * creation would, so its problems show before anything is saved.
 */
export async function previewTariff(
  d: PricingDeps,
  actor: Staff,
  form: TariffForm,
  sim: SimulationForm,
  tariffId: string | null = null,
): Promise<QuoteView> {
  requireManager(actor);
  const { currency } = await formCurrency(d, actor, tariffId);
  const { definition } = parse(tariffFormSchema(currency), form);
  const s = parse(simulationSchema, sim);
  const { billedIdleMinutes: _b, ...session } = sessionProfile(definition, s);
  let q: Quote;
  try {
    q = await d.ivora.simulateTariff(definitionInput(definition), session);
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    logIvora("tariff simulation", e);
    throw ivoraRefusal(e);
  }
  return quoteView(q, definition, s, d.ivora.mode === "demo");
}

/** The preview's starting values: today, 18:00 to 20:30, 30 kWh, 15 idle minutes. */
export function defaultSimulation(timeZone: string, now = Date.now()) {
  return {
    date: localDate(timeZone, now),
    start: "18:00",
    end: "20:30",
    energyKwh: "30",
    idleMinutes: "15",
  };
}

// ---- Saving ----

export type PublishResult =
  | {
      state: "saved";
      version: number;
      /** An older version's archive did not go through ("Finish saving" retries). */
      warning?: string;
    }
  | { state: "unconfirmed"; version: number; error: string };

/**
 * Sends the tariff's pending version to Ivora as a new tariff (`POST /tariffs`, key
 * cpo-tariff-<id>-v<n>-create, external_reference cpo-tariff-<id>-v<n>), then
 * archives the older versions with it as their replacement, so Ivora moves any
 * connectors and charger displays that used them. A version is never changed in
 * place: bills keep the tariff they snapshot. Safe to repeat ("Finish saving"): each
 * step has a key derived from the tariff and version, and a create that already
 * happened is found by its reference.
 */
export async function publishTariff(
  d: PricingDeps,
  actor: Staff,
  tariffId: string,
): Promise<PublishResult> {
  requireManager(actor);
  const find = async () => {
    const t = (await d.store.load(actor.operatorId)).tariffs.find(
      (x) => x.id === tariffId,
    );
    if (!t) throw notFound();
    return t;
  };
  let t = await find();
  const pending = pendingVersion(t);
  if (pending) {
    if (!pending.definition) throw notFound();
    try {
      const created = await d.ivora.createTariff(
        tariffInput(pending.definition, t.id, pending.version),
        idempotencyKey("tariff", `${t.id}-v${pending.version}`, "create"),
      );
      await d.store.recordVersion(actor, t.id, pending.version, created.id);
    } catch (e) {
      if (!(e instanceof IvoraError)) throw e;
      logIvora("tariff create", e);
      if (definitelyFailed(e)) {
        await d.store.dropVersion(actor, t.id, pending.version);
        throw ivoraRefusal(e);
      }
      return {
        state: "unconfirmed",
        version: pending.version,
        error: describeError(e),
      };
    }
    t = await find();
  }
  const current = currentVersion(t);
  if (!current) throw notFound();
  let warning: string | undefined;
  for (const old of unarchived(t)) {
    try {
      await d.ivora.archiveTariff(
        old.ivoraTariffId!,
        current.ivoraTariffId,
        idempotencyKey("tariff", `${t.id}-v${old.version}`, "archive"),
      );
    } catch (e) {
      if (!(e instanceof IvoraError)) throw e;
      if (e.code !== "tariff_archived") {
        logIvora("tariff archive", e);
        warning = `Version ${old.version} is still active in Ivora (${describeError(e)}). Bills made with the kit use version ${current.version}; use "Finish saving" to archive it.`;
        continue;
      }
    }
    await d.store.recordArchived(actor, t.id, old.version);
  }
  return { state: "saved", version: current.version, warning };
}

/**
 * Saves the editor: a new tariff, or a new version of `tariffId`, then publishes it
 * to Ivora. A refusal from Ivora drops the version (nothing was created) and shows
 * Ivora's problems; an uncertain answer keeps it for "Finish saving".
 */
export async function saveTariff(
  d: PricingDeps,
  actor: Staff,
  form: TariffForm,
  tariffId: string | null = null,
): Promise<{ id: string; result: PublishResult }> {
  requireManager(actor);
  const { currency, tariff } = await formCurrency(d, actor, tariffId);
  const { name, definition } = parse(tariffFormSchema(currency), form);
  let id: string;
  if (tariff) {
    if (pendingVersion(tariff)) throw busy();
    await d.store.addVersion(actor, tariff.id, name, definition);
    id = tariff.id;
  } else {
    id = await d.store.createTariff(actor, name, definition);
  }
  return { id, result: await publishTariff(d, actor, id) };
}

// ---- Assignments ----

export interface StationPricingForm {
  stationId?: string;
  tariffId?: string;
  private?: boolean;
  /** Connector resource ID to kit tariff ID; "" or "station" uses the station's. */
  connectors?: Record<string, string>;
}

/**
 * Sets a station's tariff, private access and per-connector tariffs. The station and
 * its connectors are read from Ivora first (they must be in this project); each tariff
 * must be in Ivora already, so a bill always has a tariff to snapshot.
 */
export async function setStationPricing(
  d: PricingDeps,
  actor: Staff,
  form: StationPricingForm,
): Promise<{ stationName: string }> {
  requireManager(actor);
  const stationId = Number(form.stationId);
  if (!Number.isSafeInteger(stationId) || stationId <= 0)
    throw new PricingError("invalid", "Choose a charger.");
  const state = await d.store.load(actor.operatorId);
  const ready = (id: string) => {
    const t = state.tariffs.find((x) => x.id === id);
    if (!t) throw notFound();
    if (!currentVersion(t))
      throw new PricingError(
        "not_ready",
        `"${t.name}" is not in Ivora yet. Finish saving it before assigning it.`,
      );
    return id;
  };
  let station;
  try {
    station = await d.ivora.getStation(stationId);
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    logIvora("pricing station read", e);
    throw new PricingError("invalid", describeError(e));
  }
  const tariffId = form.tariffId ? ready(form.tariffId) : null;
  const connectors: { connectorId: number; tariffId: string }[] = [];
  for (const [key, value] of Object.entries(form.connectors ?? {})) {
    if (!value || value === "station") continue;
    const c = station.connectors.find((x) => String(x.id) === key);
    if (!c)
      throw new PricingError(
        "invalid",
        "That connector is not on this charger any more. Reload the page.",
      );
    connectors.push({ connectorId: c.id, tariffId: ready(value) });
  }
  await d.store.setStation(actor, stationId, {
    tariffId,
    private: Boolean(form.private),
    connectors,
  });
  return { stationName: station.name };
}
