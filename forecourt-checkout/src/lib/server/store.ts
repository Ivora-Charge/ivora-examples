import { createHash } from "node:crypto";
import type { Settings } from "../settings";
import {
  changeReport,
  chargerLabel,
  decodeSaleId,
  encodeSaleId,
  endReports,
  paidReport,
  MAX_STOP_ATTEMPTS,
  PLUGGED_STATUSES,
  prepayStop,
  READY_STATUSES,
  saleAmounts,
  saleBill,
  saleFromReference,
  saleKey,
  startReports,
  stopKey,
  STOP_PROBLEM_TEXT,
  STORE_MERCHANT,
  STORE_PROCESSOR,
  storeReference,
  tileState,
  validateTerms,
  type PaymentMethod,
  type PlannedReport,
  type SaleReport,
  type SaleTerms,
  type SaleView,
  type StopProblem,
  type Tile,
} from "../store";
import { priceBreakdown, type Tariff } from "../tariff";
import type { Connector, ExternalSession, IvoraClient, Station } from "./ivora";
import { IvoraError, isRetryLater, type Operation } from "./ivora";
import type { SaleEvents } from "./sale-events";
import {
  APPLICATION_PREFIX,
  breakdownOf,
  IDLE_POWER_W,
  START_TIMEOUT_MS,
  UserError,
} from "./sessions";

// Live pay-in-store flow. The sale ID (see src/lib/store.ts) is the Ivora
// session's payment_reference, and `forecourt:store:<sale ID>` its
// application_reference. State lives in Ivora: the session, its bill and its
// settlement reports. Every write uses a key from the sale ID and the action,
// so progressSale() can run from the console, the driver's screen, a webhook
// or the sweep, on any instance, without doing anything twice.
//
// Only authorizeSale() starts a charger, and only the cashier console calls it.

export type StoreApi = Pick<
  IvoraClient,
  | "findStationByCode"
  | "getStation"
  | "listStations"
  | "getTariff"
  | "quote"
  | "createSession"
  | "findSession"
  | "getSession"
  | "listAllSessions"
  | "startSession"
  | "stopSession"
  | "cancelSession"
  | "finalizeSession"
  | "reportSettlement"
  | "listSettlementReports"
>;

export type StoreDeps = {
  ivora: StoreApi;
  settings: Settings;
  now: () => number;
  events?: Pick<SaleEvents, "emit">;
  log?: (message: string, details: Record<string, unknown>) => void;
};

/** A prepared session the console didn't start within this time is canceled. */
export const PREPARED_TIMEOUT_MS = 2 * 60 * 1000;
/** "Paid" stays on a charger's tile this long after the sale ends. */
export const PAID_DISPLAY_MS = 10 * 60 * 1000;
/** Unpaid sales are listed this long. */
export const UNPAID_WINDOW_MS = 24 * 60 * 60 * 1000;
const IDLE_STATUSES = new Set(["SuspendedEV", "SuspendedEVSE", "Finishing"]);
const CLOSED = new Set(["completed", "canceled"]);

export type ChargerRef = {
  code: string;
  label: string;
  name: string;
  connector: number;
  connectorId: number;
  connectorLabel: string;
  tariffId: number | null;
  status: string;
  online: boolean;
  maxPowerW: number | null;
};

export function chargerRef(station: Station, connector: Connector): ChargerRef {
  const code = station.external_reference || `station-${station.id}`;
  const number = connector.number ?? 0;
  const numbered = station.connectors.filter((c) => c.number !== null);
  return {
    code,
    label: chargerLabel(code, number, numbered.length),
    name: station.name,
    connector: number,
    connectorId: connector.id,
    connectorLabel: [connector.type ?? connector.format, `connector ${number}`]
      .filter(Boolean)
      .join(" · "),
    tariffId: connector.tariff_id,
    status: station.online ? (connector.status ?? "Unknown") : "Offline",
    online: station.online,
    maxPowerW: connector.max_power_w ?? null,
  };
}

const notFound = () =>
  new UserError(404, "sale_not_found", "This sale was not found.");

const isStore = (s: ExternalSession) =>
  saleFromReference(s.application_reference) !== null;
const isCard = (s: ExternalSession) =>
  s.application_reference.startsWith(APPLICATION_PREFIX) && !isStore(s);

/** The sale ID for one tap on the console: a retry of the same tap reuses it. */
export function saleIdFor(terms: SaleTerms, requestId: string) {
  const nonce = createHash("sha256")
    .update(`forecourt-sale:${requestId}`)
    .digest("hex")
    .slice(0, 12);
  return encodeSaleId(terms, nonce);
}

function baseView(sale: string, terms: SaleTerms, c: ChargerRef): SaleView {
  return {
    sale,
    demo: false,
    terms,
    charger: {
      code: c.code,
      label: c.label,
      name: c.name,
      connector: c.connector,
    },
    phase: "starting",
    currency: "USD",
    energyWh: 0,
    powerW: null,
    runningCents: null,
    startedAt: null,
    endedAt: null,
    stopping: false,
    stopProblem: null,
    limitReached: null,
    canStop: true,
    bill: null,
    amounts: null,
    speed: 1,
    message: null,
    error: null,
  };
}

const tariffCache = new WeakMap<StoreDeps, Map<number, Promise<Tariff>>>();
function tariff(deps: StoreDeps, id: number) {
  let cache = tariffCache.get(deps);
  if (!cache) tariffCache.set(deps, (cache = new Map()));
  let t = cache.get(id);
  if (!t) {
    t = deps.ivora.getTariff(id);
    cache.set(id, t);
  }
  return t;
}

/** How long one instance reuses the session list (console polls, meter samples). */
export const SESSION_LIST_TTL_MS = 5000;
const sessionLists = new WeakMap<
  StoreApi,
  { at: number; list: Promise<ExternalSession[]> }
>();

/** Every session, paged (cursors aren't time-ordered), reused briefly per instance. */
function allSessions(deps: StoreDeps) {
  const cached = sessionLists.get(deps.ivora);
  const now = deps.now();
  if (cached && now - cached.at < SESSION_LIST_TTL_MS) return cached.list;
  const list = deps.ivora.listAllSessions();
  sessionLists.set(deps.ivora, { at: now, list });
  list.catch(() => sessionLists.delete(deps.ivora));
  return list;
}

/** A new sale must show on the next read. */
const forgetSessions = (deps: StoreDeps) => sessionLists.delete(deps.ivora);

async function send(
  deps: StoreDeps,
  session: ExternalSession,
  sale: string,
  report: PlannedReport,
) {
  // In store, the reports are the money record: a failure is shown, not swallowed.
  await deps.ivora.reportSettlement(
    session.id,
    {
      kind: report.kind,
      operation_reference: report.operation_reference,
      amount_minor: report.amount_minor,
    },
    saleKey(sale, `report:${report.step}`),
  );
}

const asReport = (r: PlannedReport): SaleReport => ({
  kind: r.kind,
  operation_reference: r.operation_reference,
  outcome: "succeeded",
  amount_minor: r.amount_minor,
});

function review(view: SaleView, code: string, message: string): SaleView {
  return {
    ...view,
    phase: "review",
    canStop: false,
    message: "Check this sale with the site team before taking payment.",
    error: { code, message, requestId: null },
  };
}

async function cancel(
  view: SaleView,
  session: ExternalSession,
  deps: StoreDeps,
  message: string,
): Promise<SaleView> {
  if (session.status !== "canceled") {
    try {
      await deps.ivora.cancelSession(session.id, saleKey(view.sale, "cancel"));
    } catch (error) {
      // start_reserved: a dispatched start could still begin; wait for the window to pass.
      if (error instanceof IvoraError && error.code === "start_reserved")
        return {
          ...view,
          phase: "starting",
          canStop: false,
          message: "Waiting for the charger to confirm the start.",
        };
      throw error;
    }
  }
  return canceled(view, session, deps, message);
}

/** Never charged. A prepaid amount is owed back in full. */
async function canceled(
  view: SaleView,
  session: ExternalSession,
  deps: StoreDeps,
  message: string,
): Promise<SaleView> {
  const amounts =
    view.terms.mode === "prepay"
      ? saleAmounts(
          view.sale,
          view.terms,
          0,
          await deps.ivora.listSettlementReports(session.id),
        )
      : null;
  return { ...view, phase: "canceled", canStop: false, amounts, message };
}

export type StopState = "sent" | StopProblem;

const isNewer = (a: Operation, b: Operation) =>
  a.id !== b.id && Date.parse(a.created_at) >= Date.parse(b.created_at);

/**
 * Make sure a stop is on its way. With no stop yet it sends one. A rejected
 * stop is retried with the next key ("stop-2", "stop-3"), at most
 * MAX_STOP_ATTEMPTS in all. Keys are replayed in order first: Ivora answers
 * a used key from its record without sending anything, so this finds where
 * the attempts got to without a database. An unknown outcome is never resent
 * with a new key, and neither is a request whose answer was lost: the next
 * check retries that same key.
 */
export async function requestStop(
  session: ExternalSession,
  sale: string,
  deps: StoreDeps,
): Promise<StopState> {
  const latest = session.stop_operation;
  if (latest?.status === "unknown") return "unconfirmed";
  if (latest && latest.status !== "rejected") return "sent";
  for (let attempt = 1; attempt <= MAX_STOP_ATTEMPTS; attempt++) {
    let op: Operation;
    try {
      op = await deps.ivora.stopSession(session.id, stopKey(sale, attempt));
    } catch (error) {
      // Not known whether it went out: retry this same key next time.
      if (isRetryLater(error) || !(error instanceof IvoraError)) throw error;
      // Ivora refused another attempt (for example: a rejected stop needs
      // reconciling first). Nothing more this app can do from here.
      if (error.status >= 400 && error.status < 500) {
        deps.log?.("stop refused", { sale, attempt, code: error.code });
        return "failed";
      }
      throw error;
    }
    // A replay of an older attempt, or the rejected latest one: try the next key.
    if (latest && !isNewer(op, latest)) continue;
    if (op.status === "unknown") return "unconfirmed";
    if (op.status !== "rejected") return "sent";
  }
  deps.log?.("stop failed", { sale, attempts: MAX_STOP_ATTEMPTS });
  return "failed";
}

function stopProblemView(view: SaleView, problem: StopProblem): SaleView {
  return {
    ...view,
    phase: "charging",
    stopping: false,
    stopProblem: problem,
    canStop: true,
    message: STOP_PROBLEM_TEXT[problem],
  };
}

/** Bring one in-store sale forward and describe it. Safe to call any number of times. */
export async function progressSale(
  session: ExternalSession,
  charger: ChargerRef,
  deps: StoreDeps,
): Promise<SaleView> {
  const sale = saleFromReference(session.application_reference);
  const terms = sale && decodeSaleId(sale);
  if (!sale || !terms) throw notFound();
  const { ivora, settings } = deps;
  const view = baseView(sale, terms, charger);

  if (session.status === "reconciliation_required")
    return review(
      view,
      "reconciliation_required",
      "Ivora needs this session reconciled before it can be billed.",
    );
  const usage = session.usage;
  if (session.status === "canceled" && !usage)
    return canceled(view, session, deps, "Canceled before charging.");

  if (!usage) {
    const start = session.start_operation;
    if (!start) {
      // authorizeSale() starts right after creating. Never start from here:
      // a start must always come from the cashier.
      if (deps.now() - Date.parse(session.created_at) > PREPARED_TIMEOUT_MS)
        return cancel(
          view,
          session,
          deps,
          "The start didn't go through. Nothing was charged.",
        );
      return { ...view, message: "Starting the charger…" };
    }
    if (
      start.status === "rejected" ||
      deps.now() - Date.parse(start.created_at) > START_TIMEOUT_MS
    )
      return cancel(
        view,
        session,
        deps,
        start.status === "rejected"
          ? "The charger did not accept the start. Nothing was charged."
          : "Charging didn't start. Nothing was charged.",
      );
    return {
      ...view,
      message: "Started. Plug in the car if it isn't yet.",
    };
  }

  const live: SaleView = {
    ...view,
    energyWh: usage.energy_wh ?? 0,
    powerW: usage.power_w ?? null,
    runningCents: usage.estimated_minor,
    startedAt: usage.started_at,
    endedAt: usage.ended_at,
  };

  if (usage.active) {
    let limitReached: SaleView["limitReached"] = null;
    if (terms.mode === "prepay" && terms.prepaidCents) {
      // Price the headroom from the tariff snapshotted for this session.
      const tariffId = session.bill.tariff_id ?? charger.tariffId;
      const b = tariffId ? priceBreakdown(await tariff(deps, tariffId)) : null;
      const decision = prepayStop({
        prepaidCents: terms.prepaidCents,
        limitWh: terms.limitWh,
        estimatedCents: usage.estimated_minor ?? 0,
        energyWh: usage.energy_wh ?? 0,
        powerW: usage.power_w ?? charger.maxPowerW,
        energyPerKwh: b?.energyPerKwh ?? 0,
        timePerHour: b?.timePerHour ?? 0,
        idlePerHour: b?.idlePerHour ?? 0,
      });
      if (decision.stop) limitReached = decision.reason;
    }
    if (limitReached || session.stop_operation) {
      const state = await requestStop(session, sale, deps);
      const stopping: SaleView = {
        ...live,
        phase: "charging",
        stopping: true,
        canStop: false,
        limitReached,
        message:
          limitReached === "energy"
            ? "Stopping: the prepaid energy is used."
            : limitReached === "amount"
              ? "Stopping: the prepaid amount is nearly used."
              : "Stopping the charger…",
      };
      return state === "sent"
        ? stopping
        : stopProblemView({ ...stopping, limitReached }, state);
    }
    const idle =
      IDLE_STATUSES.has(charger.status) ||
      (usage.power_w != null && usage.power_w < IDLE_POWER_W);
    if (idle)
      return {
        ...live,
        phase: "finished",
        message: `Charging complete. Idle fees apply after ${settings.idleGraceMinutes} free minutes until the car is unplugged.`,
      };
    return { ...live, phase: "charging" };
  }

  // The transaction ended: finalize the bill, then record what the prepaid amount covered.
  const bill =
    session.bill.status === "final"
      ? session.bill
      : usage.transaction_id
        ? await ivora.finalizeSession(
            session.id,
            usage.transaction_id,
            saleKey(sale, "finalize"),
          )
        : session.bill;
  if (bill.status !== "final" || bill.total_minor === null)
    return {
      ...live,
      phase: "settling",
      canStop: false,
      message: "Preparing the bill…",
    };
  if (usage.transaction_id && bill.transaction_id !== usage.transaction_id)
    return review(
      live,
      "bill_mismatch",
      "The bill does not match this charging transaction.",
    );
  const breakdown = breakdownOf(bill);
  const saleBillView = saleBill({
    bill: breakdown,
    billTotalCents: bill.total_minor,
    idleSeconds: breakdown.activity?.idle_seconds ?? 0,
    graceMinutes: settings.idleGraceMinutes,
  });
  let reports: SaleReport[] = await ivora.listSettlementReports(session.id);
  let amounts = saleAmounts(sale, terms, saleBillView.dueCents, reports);
  for (const report of endReports(sale, terms, amounts)) {
    await send(deps, session, sale, report);
    reports = [...reports, asReport(report)];
  }
  amounts = saleAmounts(sale, terms, saleBillView.dueCents, reports);
  const done: SaleView = {
    ...live,
    energyWh: bill.energy_wh ?? live.energyWh,
    powerW: 0,
    phase: "done",
    canStop: false,
    bill: saleBillView,
    amounts,
    message: null,
  };
  if (amounts.outstandingCents > 0)
    await deps.events?.emit({
      id: `${sale}:due`,
      type: "sale.due",
      sale,
      charger: {
        code: charger.code,
        connector: charger.connector,
        label: charger.label,
      },
      mode: terms.mode,
      amountDueCents: amounts.outstandingCents,
      currency: saleBillView.currency,
      energyWh: done.energyWh,
      startedAt: done.startedAt,
      endedAt: done.endedAt,
    });
  return done;
}

async function chargerOf(session: ExternalSession, deps: StoreDeps) {
  const station = await deps.ivora.getStation(session.bill.station_id);
  const connector = station.connectors.find(
    (c) => c.id === session.bill.connector_id,
  );
  if (!connector) throw notFound();
  return chargerRef(station, connector);
}

async function findSale(sale: string, deps: StoreDeps) {
  const terms = decodeSaleId(sale);
  if (!terms) throw notFound();
  const session = await deps.ivora.findSession(storeReference(sale));
  if (!session) throw notFound();
  return { terms, session };
}

/** One sale by ID, for the receipt and after each cashier action. */
export async function saleById(sale: string, deps: StoreDeps) {
  const { session } = await findSale(sale, deps);
  return progressSale(session, await chargerOf(session, deps), deps);
}

/** Webhooks and the sweep: move an in-store session forward. */
export async function reconcileStoreSession(
  session: ExternalSession,
  deps: StoreDeps,
) {
  const fresh = await deps.ivora.getSession(session.id);
  return progressSale(fresh, await chargerOf(fresh, deps), deps);
}

/** A meter.sampled webhook: which transaction, on which station, if the event says. */
export type MeterSample = {
  transactionId: number | null;
  stationId: number | null;
};

/**
 * A meter.sampled webhook arrived: run the prepaid stop check for the
 * prepaid sales charging there. This is what stops a prepaid sale at its
 * limit when no console or driver screen is open; the sweep is a backstop.
 */
export async function onMeterSample(
  sample: MeterSample,
  deps: StoreDeps,
): Promise<SaleView[]> {
  const open = (await allSessions(deps)).filter((s) => {
    const sale = saleFromReference(s.application_reference);
    return (
      sale !== null &&
      decodeSaleId(sale)?.mode === "prepay" &&
      !CLOSED.has(s.status) &&
      (sample.stationId === null || s.bill.station_id === sample.stationId)
    );
  });
  const views: SaleView[] = [];
  for (const s of open) {
    const fresh = await deps.ivora.getSession(s.id);
    const tx = fresh.usage?.transaction_id ?? null;
    if (
      sample.transactionId !== null &&
      tx !== null &&
      tx !== sample.transactionId
    )
      continue;
    views.push(await progressSale(fresh, await chargerOf(fresh, deps), deps));
  }
  return views;
}

export type AuthorizeInput = {
  code: string;
  connector: number;
  terms: SaleTerms;
  /** One per tap on the console; a retry after a timeout reuses it. */
  requestId: string;
};

/**
 * The cashier authorised a charger: postpay (driver pays after) or prepay (the
 * store already took the amount). The only place that starts a charger for an
 * in-store sale. Repeating the same request does nothing twice.
 */
export async function authorizeSale(
  input: AuthorizeInput,
  deps: StoreDeps,
): Promise<SaleView> {
  const { ivora } = deps;
  const problem = validateTerms(input.terms);
  if (problem) throw new UserError(400, "invalid_sale", problem);
  const sale = saleIdFor(input.terms, input.requestId);
  const station = await ivora.findStationByCode(input.code);
  const connector = station?.connectors.find(
    (c) => c.number === input.connector,
  );
  if (!station || !connector) throw notFound();
  const charger = chargerRef(station, connector);
  if (!connector.tariff_id)
    throw new UserError(
      409,
      "price_not_set",
      "This charger has no price yet. Set one on the operator Prices page.",
    );
  let session = await ivora.findSession(storeReference(sale));
  if (!session) {
    if (!station.online)
      throw new UserError(409, "charger_offline", "This charger is offline.");
    const ready =
      input.terms.mode === "postpay"
        ? PLUGGED_STATUSES.has(charger.status)
        : READY_STATUSES.has(charger.status);
    if (!ready)
      throw new UserError(
        409,
        "connector_not_ready",
        input.terms.mode === "postpay"
          ? "Pay-after needs the car plugged in first. Ask the driver to plug in."
          : `This charger is ${charger.status.toLowerCase()}.`,
      );
    session = await ivora.createSession(
      {
        station_id: station.id,
        connector_id: connector.id,
        tariff_id: connector.tariff_id,
        application_reference: storeReference(sale),
        processor: STORE_PROCESSOR,
        merchant_reference: STORE_MERCHANT,
        payment_reference: sale,
      },
      saleKey(sale, "create"),
    );
    forgetSessions(deps);
  }
  // Prepay: record the amount the store took before the charger may start.
  for (const report of startReports(sale, input.terms))
    await send(deps, session, sale, report);
  if (session.status === "prepared" && !session.start_operation)
    await ivora.startSession(session.id, saleKey(sale, "start"));
  return progressSale(await ivora.getSession(session.id), charger, deps);
}

/** The cashier pressed stop. Before charging starts, the session is canceled instead. */
export async function stopSale(sale: string, deps: StoreDeps) {
  const { session } = await findSale(sale, deps);
  const charger = await chargerOf(session, deps);
  if (!session.usage && !CLOSED.has(session.status)) {
    const view = await cancel(
      baseView(sale, decodeSaleId(sale)!, charger),
      session,
      deps,
      "Canceled before charging.",
    );
    if (view.phase === "starting") return view;
  } else if (session.usage?.active) await requestStop(session, sale, deps);
  return progressSale(await deps.ivora.getSession(session.id), charger, deps);
}

/**
 * The cashier took payment on the POS (cash or card). Records a capture
 * report for exactly what is outstanding on the final bill. This is the seam a
 * POS integration calls. Repeating it is a no-op.
 */
export async function markSalePaid(
  input: {
    sale: string;
    amountCents: number;
    method: PaymentMethod;
    posReference: string | null;
  },
  deps: StoreDeps,
): Promise<SaleView> {
  const { terms, session } = await findSale(input.sale, deps);
  const charger = await chargerOf(session, deps);
  const view = await progressSale(session, charger, deps);
  if (view.phase !== "done" || !view.amounts)
    throw new UserError(
      409,
      "bill_not_final",
      "The bill isn't final yet. Mark it paid when the charging session has ended.",
    );
  const rule = paidReport(input.sale, terms, view.amounts, input);
  if (!rule.ok) throw new UserError(409, rule.code, rule.message);
  if (!rule.report) return view;
  await send(deps, session, input.sale, rule.report);
  return progressSale(session, charger, deps);
}

/** The cashier handed back the unused prepaid amount (change, or all of it if canceled). */
export async function giveChange(sale: string, deps: StoreDeps) {
  const { session } = await findSale(sale, deps);
  const charger = await chargerOf(session, deps);
  const view = await progressSale(session, charger, deps);
  if ((view.phase !== "done" && view.phase !== "canceled") || !view.amounts)
    throw new UserError(
      409,
      "bill_not_final",
      "Give change once the charging session has ended.",
    );
  const rule = changeReport(sale, view.amounts);
  if (!rule.ok) throw new UserError(409, rule.code, rule.message);
  if (!rule.report) return view;
  await send(deps, session, sale, rule.report);
  return progressSale(session, charger, deps);
}

/** Price of a kWh limit, so the cashier knows what to take on the POS. */
export async function prepayQuote(
  input: { code: string; connector: number; energyWh: number },
  deps: StoreDeps,
) {
  const station = await deps.ivora.findStationByCode(input.code);
  const connector = station?.connectors.find(
    (c) => c.number === input.connector,
  );
  if (!connector?.tariff_id) throw notFound();
  const s = deps.settings;
  const kwh = input.energyWh / 1000;
  const quote = await deps.ivora.quote(connector.tariff_id, {
    start_at: new Date(deps.now()).toISOString(),
    time_zone: s.siteTimeZone,
    duration_minutes: Math.max(
      1,
      Math.ceil((s.typicalSessionMinutes * kwh) / s.typicalSessionKwh),
    ),
    energy_kwh: kwh,
    idle_minutes: 0,
  });
  return { totalCents: quote.total_minor, currency: quote.currency };
}

export type ConsoleState = {
  demo: boolean;
  tiles: Tile[];
  /** Ended sales with money still to collect that are no longer on a tile. */
  unpaid: SaleView[];
  graceMinutes: number;
  pollMs: number;
};

const latestFirst = (a: ExternalSession, b: ExternalSession) =>
  b.created_at.localeCompare(a.created_at);

/** Every charger as a tile, like fuel pumps. Moves active sales forward as it reads them. */
export async function consoleState(deps: StoreDeps): Promise<ConsoleState> {
  const { ivora } = deps;
  const now = deps.now();
  const [stations, sessions] = await Promise.all([
    ivora.listStations(),
    allSessions(deps),
  ]);
  const recent = sessions
    .filter((s) => now - Date.parse(s.created_at) < UNPAID_WINDOW_MS)
    .sort(latestFirst);
  const shown = new Set<string>();
  const tiles = await Promise.all(
    stations.flatMap((station) =>
      station.connectors
        .filter((c) => c.number !== null)
        .map(async (connector): Promise<Tile> => {
          const charger = chargerRef(station, connector);
          const here = recent.filter(
            (s) => s.bill.connector_id === connector.id,
          );
          const open = here.filter((s) => !CLOSED.has(s.status));
          const latest = here.find(isStore) ?? null;
          let sale: SaleView | null = null;
          if (latest) {
            const fresh = CLOSED.has(latest.status)
              ? latest
              : await ivora.getSession(latest.id);
            sale = await progressSale(fresh, charger, deps);
            const ended = Date.parse(
              sale.amounts?.settledAt ?? sale.endedAt ?? latest.created_at,
            );
            const settled =
              sale.phase === "canceled"
                ? !sale.amounts || sale.amounts.status === "paid"
                : sale.phase === "done" && sale.amounts?.status === "paid";
            if (settled && now - ended > PAID_DISPLAY_MS) sale = null;
            if (sale) shown.add(latest.id);
          }
          return {
            key: `${charger.code}/${charger.connector}`,
            code: charger.code,
            label: charger.label,
            stationName: charger.name,
            connector: charger.connector,
            connectorLabel: charger.connectorLabel,
            status: charger.status,
            online: charger.online,
            sale,
            ...tileState({
              online: charger.online,
              status: charger.status,
              sale,
              cardOpen: open.some(isCard),
              foreignOpen: open.some(
                (s) => !s.application_reference.startsWith(APPLICATION_PREFIX),
              ),
            }),
          };
        }),
    ),
  );
  // Older unpaid sales: captured less than the bill and not on a tile.
  const candidates = recent
    .filter(
      (s) =>
        isStore(s) &&
        !shown.has(s.id) &&
        s.status === "completed" &&
        (s.settlement?.captured_minor ?? 0) < (s.bill.total_minor ?? 0),
    )
    .slice(0, 10);
  const byId = new Map(stations.map((s) => [s.id, s]));
  const unpaid = (
    await Promise.all(
      candidates.map(async (s) => {
        const station = byId.get(s.bill.station_id);
        const connector = station?.connectors.find(
          (c) => c.id === s.bill.connector_id,
        );
        if (!station || !connector) return null;
        return progressSale(s, chargerRef(station, connector), deps);
      }),
    )
  ).filter(
    (v): v is SaleView => v !== null && (v.amounts?.outstandingCents ?? 0) > 0,
  );
  return {
    demo: false,
    tiles: tiles.sort(
      (a, b) =>
        a.label.localeCompare(b.label, "en", { numeric: true }) ||
        a.connector - b.connector,
    ),
    unpaid,
    graceMinutes: deps.settings.idleGraceMinutes,
    pollMs: 4000,
  };
}

export type CounterState = {
  demo: boolean;
  code: string;
  label: string;
  name: string;
  connector: number;
  status: string;
  online: boolean;
  sale: SaleView | null;
  graceMinutes: number;
  pollMs: number;
};

/** The driver's "pay at the counter" screen: the charger's current in-store sale, if any. */
export async function counterState(
  code: string,
  connectorNumber: number,
  deps: StoreDeps,
): Promise<CounterState> {
  const station = await deps.ivora.findStationByCode(code);
  const connector = station?.connectors.find(
    (c) => c.number === connectorNumber,
  );
  if (!station || !connector)
    throw new UserError(
      404,
      "charger_not_found",
      "This charger is not set up for payments.",
    );
  const charger = chargerRef(station, connector);
  const now = deps.now();
  const latest =
    (await allSessions(deps))
      .filter(
        (s) =>
          isStore(s) &&
          s.bill.connector_id === connector.id &&
          (!CLOSED.has(s.status) ||
            now - Date.parse(s.usage?.ended_at ?? s.created_at) <
              PAID_DISPLAY_MS),
      )
      .sort(latestFirst)[0] ?? null;
  const sale = latest
    ? await progressSale(
        CLOSED.has(latest.status)
          ? latest
          : await deps.ivora.getSession(latest.id),
        charger,
        deps,
      )
    : null;
  return {
    demo: false,
    code: charger.code,
    label: charger.label,
    name: charger.name,
    connector: charger.connector,
    status: charger.status,
    online: charger.online,
    sale,
    graceMinutes: deps.settings.idleGraceMinutes,
    pollMs: 4000,
  };
}
