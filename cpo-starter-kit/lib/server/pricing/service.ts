import "server-only";
import type { z } from "zod";
import type { QuotePreview } from "@/lib/action-state";
import {
  currencyOr,
  DEFAULT_CURRENCY,
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
  graceMinutes,
  holdMinor,
  PAID_CURRENCY,
  pricedElements,
  samePrices,
  summary,
  tariffInput,
  tariffReference,
} from "./tariff";
import {
  elapsedMinutes,
  localDate,
  localTimeExists,
  nextDate,
  zonedToUtc,
} from "./time";
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
  /** Milliseconds clock, for tests. */
  now?: () => number;
}

/**
 * How long after a create attempt was started "Discard this draft" waits. A create
 * gives up within MAX_REQUEST_SECONDS (20 s), but Ivora may still finish it after an
 * uncertain answer; discarding earlier could forget a version that Ivora makes a
 * moment later, leaving an unused tariff behind.
 */
export const DISCARD_WAIT_SECONDS = 120;

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

/**
 * The API refused outright: nothing was created, so the version can go. Not
 * external_reference_taken: that says a tariff with the version's reference exists
 * (an earlier attempt landed after all), so it is looked up and adopted instead.
 */
function definitelyFailed(e: unknown): boolean {
  return (
    e instanceof IvoraError &&
    e.status >= 400 &&
    e.status < 500 &&
    e.status !== 408 &&
    e.status !== 429 &&
    e.code !== "request_in_progress" &&
    e.code !== "external_reference_taken"
  );
}

const ivoraRefusal = (e: unknown) =>
  new PricingError("invalid", describeError(e), tariffProblems(e));

const graceUnsupported = () =>
  new PricingError(
    "invalid",
    "Ivora can't apply an idle grace period for this account yet, so drivers would pay the idle fee from their first idle minute. Set the idle grace period to 0 minutes, or remove the idle fee.",
  );

/** A whole number from a hidden form field, or null. */
function revisionOf(text: string | undefined): number | null {
  const n = Number(text);
  return text && /^\d{1,9}$/.test(text) && Number.isSafeInteger(n) ? n : null;
}

const reloadPage = () =>
  new PricingError(
    "invalid",
    "This form is out of date. Reload the page and try again.",
  );

/**
 * Ivora's simulation of `def` for `session`. With an idle grace period, the draft
 * carries rules.idle_grace_minutes, and the answer must show Ivora applied it
 * (idle_free_seconds); an API without the rule refuses the field, which the same
 * draft without it tells apart from any other problem. Either way the kit refuses
 * the grace period rather than promise free minutes Ivora would bill.
 */
async function simulate(
  d: PricingDeps,
  def: TariffDefinition,
  session: SessionProfile,
): Promise<Quote> {
  try {
    const q = await d.ivora.simulateTariff(definitionInput(def), session);
    if (graceMinutes(def) && typeof q.idle_free_seconds !== "number")
      throw graceUnsupported();
    return q;
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    logIvora("tariff simulation", e);
    if (graceMinutes(def) && definitelyFailed(e)) {
      try {
        await d.ivora.simulateTariff(
          definitionInput(def, { withGrace: false }),
          session,
        );
      } catch (without) {
        if (!(without instanceof IvoraError)) throw without;
        throw ivoraRefusal(definitelyFailed(without) ? without : e);
      }
      throw graceUnsupported();
    }
    throw ivoraRefusal(e);
  }
}

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
  /** Sent back with a save, which is refused if the tariff changed meanwhile. */
  revision: number;
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
  /** Sent back with a save, which is refused if the station changed meanwhile. */
  revision: number;
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
    revision: t.revision,
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
  // A company that has not picked a currency yet is normal: no warning for that.
  return {
    currency: p.currency || DEFAULT_CURRENCY,
    timeZone: p.timeZone ?? "UTC",
  };
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
        revision: sp?.revision ?? 0,
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

/**
 * A new tariff's starting values: the company's currency and time zone, and the idle
 * grace period (see idleGraceDefault).
 */
export async function newTariffDefaults(d: PricingDeps, staff: Staff) {
  requireManager(staff);
  const base = await defaults(d, staff.operatorId);
  return { ...base, idleGrace: await idleGraceDefault(d, staff, base) };
}

/**
 * The grace period an idle fee starts with in the editor: DEFAULT_IDLE_GRACE_MINUTES
 * when Ivora's simulation shows it applies rules.idle_grace_minutes, else 0, so a first
 * save is not refused on an API without the rule. A failed check also gives 0.
 */
export async function idleGraceDefault(
  d: PricingDeps,
  staff: Staff,
  base: { timeZone: string },
): Promise<number> {
  requireManager(staff);
  const probe: TariffDefinition = {
    kind: "paid",
    currency: PAID_CURRENCY,
    timeZone: base.timeZone,
    energyMinorPerKwh: 1,
    sessionFeeMinor: 0,
    idleMinorPerMinute: 1,
    idleGraceMinutes: DEFAULT_IDLE_GRACE_MINUTES,
    periods: [],
    driverText: null,
  };
  try {
    await simulate(d, probe, graceProbe(probe));
    return DEFAULT_IDLE_GRACE_MINUTES;
  } catch (e) {
    if (e instanceof PricingError) return 0;
    throw e;
  }
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
  /** For a tariff without an idle fee: see idleGraceDefault. */
  graceDefault = DEFAULT_IDLE_GRACE_MINUTES,
): EditorValues {
  if (!def)
    return {
      name,
      kind: "paid",
      timeZone: base.timeZone,
      energy: "",
      sessionFee: "",
      idleFee: "",
      idleGrace: String(graceDefault),
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
      def.idleMinorPerMinute ? def.idleGraceMinutes : graceDefault,
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

/**
 * The preview session as Ivora's session profile: every idle minute (Ivora applies
 * the grace period), and the real elapsed charging time, across a change of clocks
 * too. A start or end in a spring-forward gap does not happen, so it is refused.
 */
export function sessionProfile(
  def: TariffDefinition,
  s: Simulation,
): SessionProfile {
  const endDate = s.end > s.start ? s.date : nextDate(s.date);
  for (const [date, time] of [
    [s.date, s.start],
    [endDate, s.end],
  ])
    if (!localTimeExists(date, time, def.timeZone))
      throw new PricingError(
        "invalid",
        `${time} does not happen on ${date} in ${def.timeZone}: the clocks go forward then. Choose another time.`,
      );
  return {
    start_at: zonedToUtc(s.date, s.start, def.timeZone).toISOString(),
    time_zone: def.timeZone,
    duration_minutes: elapsedMinutes(s.date, s.start, s.end, def.timeZone),
    energy_kwh: s.energyKwh,
    idle_minutes: s.idleMinutes,
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
  const periodOf = pricedElements(def).map((x) => x.period);
  const freeMinutes =
    typeof q.idle_free_seconds === "number"
      ? trim((q.idle_free_seconds / 60).toFixed(2))
      : null;
  const label = (type: string, element: number) => {
    if (type === "ENERGY") {
      const i = periodOf[element];
      const p = i != null && def.kind === "paid" ? def.periods[i] : undefined;
      return p && i != null
        ? `Energy, period ${i + 1} (${describeDays(p.days)} ${p.start}–${p.end})`
        : "Energy, base price";
    }
    if (type === "FLAT") return "Session fee";
    if (type === "PARKING_TIME")
      return freeMinutes !== null
        ? `Idle fee (after ${freeMinutes} free ${freeMinutes === "1" ? "minute" : "minutes"})`
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
  const warnings: string[] = [];
  if (q.lines.reduce((a, l) => a + l.amount_minor, 0) !== q.subtotal_minor)
    notes.push(
      "Lines are rounded for display; the total rounds the exact sum once, as bills do.",
    );
  if (
    s.idleMinutes &&
    freeMinutes !== null &&
    !q.lines.some((l) => l.type === "PARKING_TIME")
  )
    notes.push(
      `Ivora counted ${freeMinutes} of the ${s.idleMinutes} idle minutes as free, so there is no idle fee.`,
    );
  if (def.idleMinorPerMinute)
    notes.push(
      "Ivora bills idle time whenever a car is plugged in but not charging: after charging ends, and while charging is paused. This preview has idle time after charging only.",
    );
  const total = formatMinor(q.total_minor, c);
  const hold = holdMinor(def);
  if (hold && q.total_minor > hold)
    warnings.push(
      `This session costs ${total}, more than the ${formatMinor(hold, def.currency)} card hold taken before charging. A card payment can collect at most what was held, so check the hold covers your longest sessions.`,
    );
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
    warnings,
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
  return { currency: currencyOr(def?.currency), tariff: t };
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
  const { definition } = parse(
    tariffFormSchema(currency, { purpose: "preview" }),
    form,
  );
  const s = parse(simulationSchema, sim);
  const q = await simulate(d, definition, sessionProfile(definition, s));
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

const createKey = (tariffId: string, version: number, attempt: number) =>
  idempotencyKey("tariff", `${tariffId}-v${version}-a${attempt}`, "create");

/**
 * The Ivora tariff of a version whose create was answered external_reference_taken,
 * or null when the lookup fails or finds none (the version stays unconfirmed).
 */
async function adoptByReference(
  d: PricingDeps,
  tariffId: string,
  version: number,
): Promise<number | null> {
  try {
    const found = await d.ivora.findTariff(tariffReference(tariffId, version));
    return found && !found.archived ? found.id : null;
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    logIvora("tariff lookup", e);
    return null;
  }
}

/**
 * Sends the tariff's pending version to Ivora as a new tariff (`POST /tariffs`,
 * external_reference cpo-tariff-<id>-v<n>, key cpo-tariff-<id>-v<n>-a<k>-create),
 * then archives the older versions with it as their replacement, so Ivora moves any
 * connectors and charger displays that used them. A version is never changed in
 * place: bills keep the tariff they snapshot.
 *
 * Safe to repeat ("Finish saving", `retry`): the version is first looked up by its
 * reference and adopted if Ivora has it. If not, the create is sent again as a new
 * attempt with a new key (the same key would only replay its uncertain answer). The
 * body of a version never changes and its number is never reused, so no key is ever
 * sent with two bodies, and the reference stops a second tariff being made.
 */
export async function publishTariff(
  d: PricingDeps,
  actor: Staff,
  tariffId: string,
  { retry = true }: { retry?: boolean } = {},
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
    const unconfirmed = (e: unknown): PublishResult => ({
      state: "unconfirmed",
      version: pending.version,
      error: describeError(e),
    });
    let ivoraId: number | null = null;
    let attempt = pending.attempt;
    if (retry) {
      // A failed lookup says nothing about the create: keep the version as it is.
      let found;
      try {
        found = await d.ivora.findTariff(
          tariffReference(t.id, pending.version),
        );
      } catch (e) {
        if (!(e instanceof IvoraError)) throw e;
        logIvora("tariff lookup", e);
        return unconfirmed(e);
      }
      if (found?.archived)
        throw new PricingError(
          "invalid",
          `Ivora has version ${pending.version} of this tariff, but archived. Discard this draft and save the prices again.`,
        );
      if (found) ivoraId = found.id;
      else attempt = await d.store.nextAttempt(actor, t.id, pending.version);
    }
    try {
      if (ivoraId === null)
        ivoraId = (
          await d.ivora.createTariff(
            tariffInput(pending.definition, t.id, pending.version),
            createKey(t.id, pending.version, attempt),
          )
        ).id;
      await d.store.recordVersion(actor, t.id, pending.version, ivoraId);
    } catch (e) {
      if (!(e instanceof IvoraError)) throw e;
      logIvora("tariff create", e);
      if (definitelyFailed(e)) {
        await d.store.dropVersion(actor, t.id, pending.version);
        throw ivoraRefusal(e);
      }
      // An earlier attempt landed between the lookup and this one: adopt it.
      const adopted =
        e.code === "external_reference_taken"
          ? await adoptByReference(d, t.id, pending.version)
          : null;
      if (!adopted) return unconfirmed(e);
      await d.store.recordVersion(actor, t.id, pending.version, adopted);
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
        idempotencyKey(
          "tariff",
          `${t.id}-v${old.version}`,
          `archive-to-v${current.version}`,
        ),
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
 * Gives up on an unconfirmed version. Ivora is asked first: a tariff it made for the
 * version anyway is archived (nothing uses it yet), then the version is forgotten and
 * drivers keep the current one. A tariff with no other version goes with it. Its
 * number is not reused.
 */
export async function discardPendingVersion(
  d: PricingDeps,
  actor: Staff,
  tariffId: string,
): Promise<{ version: number; tariffRemoved: boolean }> {
  requireManager(actor);
  const t = (await d.store.load(actor.operatorId)).tariffs.find(
    (x) => x.id === tariffId,
  );
  if (!t) throw notFound();
  const pending = pendingVersion(t);
  if (!pending)
    throw new PricingError(
      "invalid",
      "There is no unconfirmed version to discard. Reload the page.",
    );
  // A create sent moments ago may still land after the lookup below finds nothing.
  const wait = Math.ceil(
    (Date.parse(pending.attemptedAt) +
      DISCARD_WAIT_SECONDS * 1000 -
      (d.now ?? Date.now)()) /
      1000,
  );
  if (wait > 0)
    throw new PricingError(
      "busy",
      `Ivora may still be creating version ${pending.version}. Wait ${wait} seconds, then discard it (or use "Finish saving").`,
    );
  try {
    const found = await d.ivora.findTariff(
      tariffReference(t.id, pending.version),
    );
    if (found && !found.archived)
      await d.ivora.archiveTariff(
        found.id,
        null,
        idempotencyKey("tariff", `${t.id}-v${pending.version}`, "discard"),
      );
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    if (e.code !== "tariff_archived") {
      logIvora("tariff discard", e);
      throw new PricingError(
        "invalid",
        `The draft is kept: the kit could not make sure Ivora has no tariff for it. ${describeError(e)}`,
      );
    }
  }
  await d.store.dropVersion(actor, t.id, pending.version);
  return { version: pending.version, tariffRemoved: t.versions.length === 1 };
}

/** A sample session for checking that Ivora applies an idle grace period. */
const graceProbe = (def: TariffDefinition): SessionProfile => ({
  start_at: new Date().toISOString(),
  time_zone: def.timeZone,
  duration_minutes: 60,
  energy_kwh: 10,
  idle_minutes: def.idleGraceMinutes + 5,
});

/**
 * Saves the editor: a new tariff, or a new version of `tariffId`, then publishes it
 * to Ivora. A new version is refused if the tariff changed since the editor was
 * loaded (its revision), and while the driver text is the operator's own and the
 * prices changed, until they confirm it still fits. An idle grace period is checked
 * with Ivora's simulation first. A refusal from Ivora drops the version (nothing was
 * created) and shows Ivora's problems; an uncertain answer keeps it for "Finish
 * saving".
 */
export async function saveTariff(
  d: PricingDeps,
  actor: Staff,
  form: TariffForm,
  tariffId: string | null = null,
): Promise<{ id: string; result: PublishResult }> {
  requireManager(actor);
  const { currency, tariff } = await formCurrency(d, actor, tariffId);
  const { name, definition } = parse(
    tariffFormSchema(currency, {
      purpose: "save",
      existing: Boolean(tariff),
      sample: actor.demo,
    }),
    form,
  );
  let expected: number | null = null;
  if (tariff) {
    expected = revisionOf(form.revision);
    if (expected === null) throw reloadPage();
    if (pendingVersion(tariff)) throw busy();
    const before =
      pendingVersion(tariff)?.definition ?? currentVersion(tariff)?.definition;
    if (
      before &&
      definition.driverText !== null &&
      definition.driverText === before.driverText &&
      !samePrices(before, definition) &&
      form.driverTextConfirmed !== "on"
    )
      throw new PricingError(
        "invalid",
        'The prices changed, but your text for drivers did not. Update it, clear it to use the kit\'s description, or tick "My text for drivers matches these prices".',
      );
  }
  if (graceMinutes(definition))
    await simulate(d, definition, graceProbe(definition));
  let id: string;
  if (tariff) {
    await d.store.addVersion(actor, tariff.id, expected!, name, definition);
    id = tariff.id;
  } else {
    id = await d.store.createTariff(actor, name, definition);
  }
  return {
    id,
    result: await publishTariff(d, actor, id, { retry: false }),
  };
}

// ---- Assignments ----

export interface StationPricingForm {
  stationId?: string;
  /** The station's revision the form was loaded at. */
  revision?: string;
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
  const expected = revisionOf(form.revision);
  if (expected === null) throw reloadPage();
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
  await d.store.setStation(actor, stationId, expected, {
    tariffId,
    private: Boolean(form.private),
    connectors,
  });
  return { stationName: station.name };
}
