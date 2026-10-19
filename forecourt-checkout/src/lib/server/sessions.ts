import type { Hold, PaymentGateway } from "../payments";
import { MAX_HOLD_CENTS, MIN_HOLD_CENTS, type Settings } from "../settings";
import {
  priceBreakdown,
  priceLines,
  quoteRows,
  type Quote,
  type QuoteRow,
  type Tariff,
} from "../tariff";
import { idleFeeTiming } from "../idle";
import { buildReceipt, type SessionView } from "../view";
import type { Bill, ExternalSession, IvoraClient, Station } from "./ivora";
import { IvoraError } from "./ivora";

// Live session flow. The Stripe Checkout Session ID is the app's session ID;
// Ivora's externally funded session carries it as application_reference and
// the PaymentIntent as payment_reference. Every write uses a key derived from
// the session ID and the action, so any instance can run reconcile() again
// (from a poll, a webhook or the cron sweep) without doing anything twice.

export type ChargingApi = Pick<
  IvoraClient,
  | "findStationByCode"
  | "getStation"
  | "getTariff"
  | "quote"
  | "createSession"
  | "findSession"
  | "getSession"
  | "startSession"
  | "stopSession"
  | "cancelSession"
  | "finalizeSession"
  | "reportSettlement"
>;

export type Deps = {
  ivora: ChargingApi;
  payments: PaymentGateway;
  settings: Settings;
  now: () => number;
  log?: (message: string, details: Record<string, unknown>) => void;
};

export class UserError extends Error {
  readonly name = "UserError";
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const LIVE_SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
export const APPLICATION_PREFIX = "forecourt:";
/** Stop before the running cost reaches the hold; meters and networks lag. */
export const NEAR_HOLD_RATIO = 0.85;
/** Ivora's charging token lives 15 minutes; cancel is allowed 20 minutes after dispatch. */
export const START_TIMEOUT_MS = 20 * 60 * 1000;
/** Below this power (W) a connected car is treated as idle, as Ivora does. */
export const IDLE_POWER_W = 100;
const IDLE_STATUSES = new Set(["SuspendedEV", "SuspendedEVSE", "Finishing"]);
const READY_STATUSES = new Set(["Available", "Preparing"]);

export const applicationReference = (id: string) =>
  `${APPLICATION_PREFIX}${id}`;

export function holdFor(tariff: Tariff, settings: Settings) {
  const fromTariff = tariff.authorization_minor;
  return Number.isSafeInteger(fromTariff) &&
    fromTariff >= MIN_HOLD_CENTS &&
    fromTariff <= MAX_HOLD_CENTS
    ? fromTariff
    : settings.defaultHoldCents;
}

export type ChargerPage = {
  demo: boolean;
  code: string;
  name: string;
  connector: {
    number: number;
    label: string;
    maxPowerW: number | null;
    status: string;
    available: boolean;
  };
  prices: { label: string; value: string }[];
  conditional: boolean;
  pricingSummary: string | null;
  estimate: {
    kwh: number;
    minutes: number;
    rows: QuoteRow[];
    totalCents: number;
  };
  holdCents: number;
  currency: string;
  graceMinutes: number;
  idlePerMinuteCents: number;
};

function connectorLabel(c: Station["connectors"][number]) {
  return [c.type ?? c.format, `connector ${c.number}`]
    .filter(Boolean)
    .join(" · ");
}

async function chargerParts(
  code: string,
  connectorNumber: number,
  ivora: ChargingApi,
) {
  const station = await ivora.findStationByCode(code);
  const connector = station?.connectors.find(
    (c) => c.number === connectorNumber,
  );
  if (!station || !connector)
    throw new UserError(
      404,
      "charger_not_found",
      "This charger is not set up for payments.",
    );
  if (!connector.tariff_id)
    throw new UserError(
      409,
      "price_not_set",
      "This charger has no price yet. Please ask the site staff.",
    );
  return { station, connector, tariffId: connector.tariff_id };
}

export async function loadChargerPage(
  code: string,
  connectorNumber: number,
  deps: Deps,
): Promise<ChargerPage> {
  const { ivora, settings } = deps;
  const { station, connector, tariffId } = await chargerParts(
    code,
    connectorNumber,
    ivora,
  );
  const tariff = await ivora.getTariff(tariffId);
  const quote = await ivora.quote(tariffId, {
    start_at: new Date(deps.now()).toISOString(),
    time_zone: settings.siteTimeZone,
    duration_minutes: settings.typicalSessionMinutes,
    energy_kwh: settings.typicalSessionKwh,
    idle_minutes: 0,
  });
  return chargerPage({
    demo: false,
    code,
    name: station.name,
    connector: {
      number: connectorNumber,
      label: connectorLabel(connector),
      maxPowerW: connector.max_power_w ?? null,
      status: station.online ? (connector.status ?? "Unknown") : "Offline",
      available: station.online && READY_STATUSES.has(connector.status ?? ""),
    },
    tariff,
    quote,
    settings,
  });
}

export function chargerPage(input: {
  demo: boolean;
  code: string;
  name: string;
  connector: ChargerPage["connector"];
  tariff: Tariff;
  quote: Quote;
  settings: Settings;
}): ChargerPage {
  const b = priceBreakdown(input.tariff);
  return {
    demo: input.demo,
    code: input.code,
    name: input.name,
    connector: input.connector,
    prices: priceLines(b),
    conditional: b.conditional,
    pricingSummary: input.tariff.pricing_summary ?? null,
    estimate: {
      kwh: input.settings.typicalSessionKwh,
      minutes: input.settings.typicalSessionMinutes,
      rows: quoteRows(input.quote),
      totalCents: input.quote.total_minor,
    },
    holdCents: holdFor(input.tariff, input.settings),
    currency: input.tariff.currency,
    graceMinutes: input.settings.idleGraceMinutes,
    idlePerMinuteCents: Math.round(b.idlePerHour / 100 / 60),
  };
}

/** Pay: places a card hold through hosted checkout. Charging starts after authorization. */
export async function createCheckout(
  input: { code: string; connector: number; requestId: string },
  deps: Deps,
) {
  const { ivora, payments, settings } = deps;
  const { station, connector, tariffId } = await chargerParts(
    input.code,
    input.connector,
    ivora,
  );
  if (!station.online || !READY_STATUSES.has(connector.status ?? ""))
    throw new UserError(
      409,
      "connector_not_ready",
      "This connector is not ready. Check the cable and try again.",
    );
  const tariff = await ivora.getTariff(tariffId);
  if (tariff.archived)
    throw new UserError(
      409,
      "price_not_set",
      "This charger's price is being updated. Please try again shortly.",
    );
  const holdCents = holdFor(tariff, settings);
  const metadata = {
    fc_code: input.code,
    fc_connector_number: String(input.connector),
    fc_station: String(station.id),
    fc_connector: String(connector.id),
    fc_tariff: String(tariffId),
    fc_hold: String(holdCents),
    fc_name: station.name.slice(0, 100),
  };
  return payments.createCheckout({
    idempotencyKey: `forecourt:checkout:${input.requestId}`,
    holdCents,
    currency: tariff.currency,
    title: `EV charging hold · ${station.name}`.slice(0, 120),
    description:
      "Temporary hold. You pay only for the charging session; the rest is released when you finish.",
    metadata,
    successUrl: `${settings.publicBaseUrl}/s/{CHECKOUT_SESSION_ID}`,
    cancelUrl: `${settings.publicBaseUrl}/c/${encodeURIComponent(input.code)}/${input.connector}`,
  });
}

type Meta = {
  code: string;
  connectorNumber: number;
  station: number;
  connector: number;
  tariff: number;
  hold: number;
  name: string;
};

function readMeta(metadata: Record<string, string>): Meta | null {
  const n = (k: string) =>
    /^\d+$/.test(metadata[k] ?? "") ? Number(metadata[k]) : NaN;
  const meta = {
    code: metadata.fc_code ?? "",
    connectorNumber: n("fc_connector_number"),
    station: n("fc_station"),
    connector: n("fc_connector"),
    tariff: n("fc_tariff"),
    hold: n("fc_hold"),
    name: metadata.fc_name ?? "",
  };
  return meta.code && Object.values(meta).every((v) => v === v) ? meta : null;
}

function holdMatches(hold: Hold, meta: Meta) {
  return (
    hold.manualCapture &&
    hold.currency.toLowerCase() === "usd" &&
    hold.amountCents === meta.hold &&
    hold.metadata.fc_station === String(meta.station) &&
    hold.metadata.fc_connector === String(meta.connector)
  );
}

function baseView(id: string, meta: Meta): SessionView {
  return {
    id,
    demo: false,
    phase: "starting",
    charger: {
      code: meta.code,
      name: meta.name,
      connector: meta.connectorNumber,
    },
    currency: "USD",
    holdCents: meta.hold,
    checkoutUrl: null,
    energyWh: 0,
    powerW: null,
    runningCents: null,
    startedAt: null,
    endedAt: null,
    idle: null,
    speed: 1,
    canStop: true,
    receipt: null,
    message: null,
    error: null,
  };
}

async function report(
  deps: Deps,
  session: ExternalSession,
  kind: "authorization" | "capture" | "release",
  amount: number,
  reference: string,
) {
  // Optional audit trail; charging and finalization never depend on it.
  try {
    await deps.ivora.reportSettlement(session.id, {
      kind,
      operation_reference: reference,
      amount_minor: amount,
    });
  } catch (error) {
    deps.log?.("settlement report failed", {
      kind,
      code: error instanceof IvoraError ? error.code : "unknown",
    });
  }
}

async function releaseHold(
  id: string,
  hold: Hold,
  session: ExternalSession | null,
  deps: Deps,
) {
  if (hold.status === "requires_capture") {
    await deps.payments.release(hold.id, `forecourt:${id}:release`);
    if (session) await report(deps, session, "release", 0, hold.id);
  }
}

/** Bills on simple tariffs may carry no breakdown: show one energy line. */
function breakdownOf(bill: Bill): Quote {
  if (bill.cost_breakdown) return bill.cost_breakdown;
  const total = bill.total_minor ?? 0;
  const kwh = ((bill.energy_wh ?? 0) / 1000).toFixed(3);
  return {
    currency: bill.currency,
    pricing_version: "energy-v1",
    lines: [
      {
        type: "ENERGY",
        element: 0,
        reservation: false,
        quantity: kwh,
        unit: "kWh",
        price_minor: Number(kwh) > 0 ? (total / Number(kwh)).toFixed(2) : "0",
        exact_minor: `${total}.000000`,
        amount_minor: total,
      },
    ],
    subtotal_minor: total,
    exact_subtotal_minor: `${total}.000000`,
    adjustments: [],
    total_minor: total,
  };
}

/** Bring one session forward and describe it. Safe to call any number of times. */
export async function reconcile(id: string, deps: Deps): Promise<SessionView> {
  if (!LIVE_SESSION_ID.test(id))
    throw new UserError(
      404,
      "session_not_found",
      "Charging session not found.",
    );
  const { ivora, payments } = deps;
  const checkout = await payments.getCheckout(id);
  const meta = checkout && readMeta(checkout.metadata);
  if (!checkout || !meta)
    throw new UserError(
      404,
      "session_not_found",
      "Charging session not found.",
    );
  const view = baseView(id, meta);

  if (checkout.status === "open")
    return { ...view, phase: "payment", checkoutUrl: checkout.url };
  const hold = checkout.hold;
  if (checkout.status === "expired" || !hold || hold.status === "canceled") {
    const session = await ivora.findSession(applicationReference(id));
    if (!session || (session.status === "canceled" && !session.usage))
      return {
        ...view,
        phase: "canceled",
        canStop: false,
        message: "No charge was made.",
      };
  }
  if (!hold) return { ...view, phase: "payment", checkoutUrl: checkout.url };
  if (!holdMatches(hold, meta))
    return review(
      view,
      "payment_mismatch",
      "The payment does not match this charger session.",
    );

  let session = hold.metadata.ivora_session
    ? await ivora.getSession(hold.metadata.ivora_session)
    : await ivora.findSession(applicationReference(id));

  if (!session) {
    if (hold.status !== "requires_capture")
      return review(
        view,
        "payment_not_authorized",
        "The card hold is not available to start charging.",
      );
    if (hold.metadata.stop_requested) {
      await releaseHold(id, hold, null, deps);
      return {
        ...view,
        phase: "canceled",
        canStop: false,
        message: "Canceled before charging. Your hold was released.",
      };
    }
    session = await ivora.createSession(
      {
        station_id: meta.station,
        connector_id: meta.connector,
        tariff_id: meta.tariff,
        application_reference: applicationReference(id),
        processor: payments.processor,
        merchant_reference: payments.merchantReference,
        payment_reference: hold.id,
      },
      `forecourt:${id}:create`,
    );
    await payments.setHoldMetadata(hold.id, { ivora_session: session.id });
    await report(deps, session, "authorization", hold.amountCents, hold.id);
  }
  return progress(id, view, session, hold, deps);
}

function review(view: SessionView, code: string, message: string): SessionView {
  return {
    ...view,
    phase: "review",
    canStop: false,
    message:
      "The site team has been notified. You are only charged for energy delivered; any unused hold is released.",
    error: { code, message, requestId: null },
  };
}

async function cancelAndRelease(
  id: string,
  view: SessionView,
  session: ExternalSession,
  hold: Hold,
  deps: Deps,
  message: string,
) {
  if (session.status !== "canceled") {
    try {
      session = await deps.ivora.cancelSession(
        session.id,
        `forecourt:${id}:cancel`,
      );
    } catch (error) {
      // start_reserved: a dispatched start could still begin; wait for the window to pass.
      if (error instanceof IvoraError && error.code === "start_reserved")
        return {
          ...view,
          phase: "starting" as const,
          message:
            "Waiting for the charger to confirm. If it doesn't start, your hold is released automatically.",
        };
      throw error;
    }
  }
  await releaseHold(id, hold, session, deps);
  return { ...view, phase: "canceled" as const, canStop: false, message };
}

async function progress(
  id: string,
  view: SessionView,
  session: ExternalSession,
  hold: Hold,
  deps: Deps,
): Promise<SessionView> {
  const { ivora, payments, settings } = deps;
  const usage = session.usage;
  const stopRequested = Boolean(hold.metadata.stop_requested);

  if (session.status === "reconciliation_required")
    return review(
      view,
      "reconciliation_required",
      "Ivora needs this session reconciled before it can be billed.",
    );

  if (session.status === "canceled" && !usage) {
    await releaseHold(id, hold, session, deps);
    return {
      ...view,
      phase: "canceled",
      canStop: false,
      message: "No charging took place. Your hold was released.",
    };
  }

  if (!usage) {
    const start = session.start_operation;
    if (!start) {
      if (stopRequested)
        return cancelAndRelease(
          id,
          view,
          session,
          hold,
          deps,
          "Canceled before charging. Your hold was released.",
        );
      if (hold.status !== "requires_capture")
        return review(
          view,
          "payment_not_authorized",
          "The card hold is not available to start charging.",
        );
      await ivora.startSession(session.id, `forecourt:${id}:start`);
      return {
        ...view,
        phase: "starting",
        message: "Starting the charger. Plug in your car if you haven't.",
      };
    }
    const age = deps.now() - Date.parse(start.created_at);
    if (start.status === "rejected" || stopRequested || age > START_TIMEOUT_MS)
      return cancelAndRelease(
        id,
        view,
        session,
        hold,
        deps,
        start.status === "rejected"
          ? "The charger did not accept the start. Your hold was released."
          : "Charging didn't start. Your hold was released.",
      );
    return {
      ...view,
      phase: "starting",
      message: "Starting the charger. Plug in your car if you haven't.",
    };
  }

  const energyWh = usage.energy_wh ?? 0;
  const live = {
    ...view,
    energyWh,
    powerW: usage.power_w ?? null,
    runningCents: usage.estimated_minor,
    startedAt: usage.started_at,
    endedAt: usage.ended_at,
  };

  if (usage.active) {
    const estimated = usage.estimated_minor ?? 0;
    const nearHold =
      estimated >= Math.floor(hold.amountCents * NEAR_HOLD_RATIO);
    if ((stopRequested || nearHold) && !session.stop_operation) {
      await ivora.stopSession(session.id, `forecourt:${id}:stop`);
      return {
        ...live,
        phase: "charging",
        canStop: false,
        message: nearHold
          ? "Stopping: the session reached your card hold."
          : "Stopping the charger…",
      };
    }
    if (session.stop_operation)
      return {
        ...live,
        phase: "charging",
        canStop: false,
        message: "Stopping the charger…",
      };

    const station = await ivora.getStation(Number(hold.metadata.fc_station));
    const status =
      station.connectors.find(
        (c) => c.id === Number(hold.metadata.fc_connector),
      )?.status ?? "";
    const idle =
      IDLE_STATUSES.has(status) ||
      (usage.power_w != null && usage.power_w < IDLE_POWER_W);
    if (!idle) {
      if (hold.metadata.idle_since)
        await payments.setHoldMetadata(hold.id, { idle_since: "" });
      return { ...live, phase: "charging" };
    }
    let idleSince = hold.metadata.idle_since;
    if (!idleSince) {
      idleSince = new Date(deps.now()).toISOString();
      await payments.setHoldMetadata(hold.id, { idle_since: idleSince });
    }
    const tariff = await ivora.getTariff(Number(hold.metadata.fc_tariff));
    const b = priceBreakdown(tariff);
    const timing = idleFeeTiming({
      idleSince,
      graceMinutes: settings.idleGraceMinutes,
      idleCentsPerHour: b.idlePerHour / 100,
      stepSeconds: b.idleStepSeconds,
      now: deps.now(),
    });
    return {
      ...live,
      phase: "finished",
      message: "Charging complete. Please move your car.",
      idle: {
        ...timing,
        idleCentsPerHour: b.idlePerHour / 100,
        graceMinutes: settings.idleGraceMinutes,
      },
    };
  }

  // The transaction ended: finalize the bill, then capture or release.
  const bill =
    session.bill.status === "final"
      ? session.bill
      : usage.transaction_id
        ? await ivora.finalizeSession(
            session.id,
            usage.transaction_id,
            `forecourt:${id}:finalize`,
          )
        : session.bill;
  if (bill.status !== "final" || bill.total_minor === null)
    return {
      ...live,
      phase: "settling",
      canStop: false,
      message: "Preparing your receipt…",
    };
  if (usage.transaction_id && bill.transaction_id !== usage.transaction_id)
    return review(
      live,
      "bill_mismatch",
      "The bill does not match this charging transaction.",
    );

  const breakdown = breakdownOf(bill);
  const receipt = buildReceipt({
    bill: breakdown,
    billTotalCents: bill.total_minor,
    holdCents: hold.amountCents,
    idleSeconds: breakdown.activity?.idle_seconds ?? 0,
    graceMinutes: settings.idleGraceMinutes,
    applicationFeeBps: settings.applicationFeeBps,
    chargeApplicationFee: payments.chargesApplicationFee,
    energyWh: bill.energy_wh ?? energyWh,
    startedAt: usage.started_at,
    endedAt: usage.ended_at,
  });
  const s = receipt.settlement;

  if (hold.status === "requires_capture") {
    if (s.action === "capture") {
      const captured = await payments.capture(
        hold.id,
        s.chargedCents,
        s.applicationFeeCents,
        `forecourt:${id}:capture`,
      );
      if (
        captured.status !== "succeeded" ||
        captured.capturedCents !== s.chargedCents
      )
        return review(
          live,
          "capture_mismatch",
          "The card capture did not match the bill.",
        );
      await report(deps, session, "capture", s.chargedCents, hold.id);
    } else {
      await payments.release(hold.id, `forecourt:${id}:release`);
      await report(deps, session, "release", 0, hold.id);
    }
  } else if (hold.status === "succeeded") {
    if (s.action !== "capture" || hold.capturedCents !== s.chargedCents)
      return review(
        live,
        "capture_mismatch",
        "The card capture did not match the bill.",
      );
  } else if (hold.status === "canceled") {
    if (s.action !== "release")
      return review(
        live,
        "hold_released",
        "The card hold ended before the bill was captured.",
      );
  } else {
    return {
      ...live,
      phase: "settling",
      canStop: false,
      message: "Preparing your receipt…",
    };
  }
  return {
    ...live,
    phase: "completed",
    canStop: false,
    receipt,
    message: stopRequested
      ? "Charging stopped. Please move your car so the next driver can charge."
      : null,
  };
}

/** The driver pressed stop (or canceled before paying). */
export async function requestStop(
  id: string,
  deps: Deps,
): Promise<SessionView> {
  if (!LIVE_SESSION_ID.test(id))
    throw new UserError(
      404,
      "session_not_found",
      "Charging session not found.",
    );
  const checkout = await deps.payments.getCheckout(id);
  if (!checkout)
    throw new UserError(
      404,
      "session_not_found",
      "Charging session not found.",
    );
  if (checkout.status === "open") {
    await deps.payments.expireCheckout(id, `forecourt:${id}:expire`);
    return reconcile(id, deps);
  }
  if (checkout.hold && !checkout.hold.metadata.stop_requested)
    await deps.payments.setHoldMetadata(checkout.hold.id, {
      stop_requested: "1",
    });
  return reconcile(id, deps);
}
