import "server-only";
import { formatMinor } from "@/lib/money";
import { isStickerCode } from "@/lib/sticker-codes";
import type { ChargerStore, ResolvedCode } from "../chargers/types";
import {
  idempotencyKey,
  IvoraError,
  type Bill,
  type BillProgress,
  type IvoraClient,
  type Payment,
  type Quote,
  type Station,
} from "../ivora";
import { stripeView } from "../onboarding/stripe";
import { effectiveTariff } from "../pricing/service";
import { driverText, holdMinor } from "../pricing/tariff";
import type { PricingStore, TariffDefinition } from "../pricing/types";
import { digest, type RateLimiter } from "../rate-limit";
import {
  CheckoutError,
  type CheckoutErrorCode,
  type CheckoutRecord,
  type CheckoutStore,
} from "./types";

// Driver checkout, shared by demo and live mode. Drivers are not staff: the sticker's
// code is the only thing they bring, so every check (charger, connector, price,
// private, Stripe) happens here on the server before Ivora is asked for anything. The
// money goes through Ivora Checkout to the operator's own Stripe account: the kit
// holds no Stripe keys and never sees a card. Logs carry codes and record IDs only.

export interface CheckoutDeps {
  store: CheckoutStore;
  ivora: IvoraClient;
  chargers: Pick<ChargerStore, "resolveCode">;
  pricing: Pick<PricingStore, "load">;
  limiter: RateLimiter;
  /** Keys the rate-limit digests, so sources and connectors are never stored plain. */
  secret: string;
  /** Short-lived reads shared by page views (see `cached`). */
  cache: Map<string, { until: number; value: unknown }>;
  now?: () => number;
}

/**
 * Ivora Checkout expires 60 minutes after the payment was first requested. A driver
 * sent back to it later would land on an expired page, so the kit stops a few minutes
 * earlier and asks for a new checkout.
 */
export const CHECKOUT_REUSE_MINUTES = 55;
/** A returning driver's sessions are shown on the sticker's page this long. */
export const DRIVER_SESSION_HOURS = 12;

/**
 * "Pay and charge" quotas. Per source and per connector, and a total per operator that
 * holds when there is no trusted client address (see sourceOf).
 */
export const CHECKOUT_LIMITS = {
  source: { quota: 10, periodSeconds: 600 },
  connector: { quota: 20, periodSeconds: 3600 },
  operator: { quota: 300, periodSeconds: 3600 },
} as const;

/** The example session the page prices with Ivora's quote: 20 kWh over an hour. */
export const EXAMPLE_SESSION = { energyKwh: 20, minutes: 60 } as const;

const now = (d: CheckoutDeps) => (d.now ?? Date.now)();

function log(what: string, e: unknown, record?: string) {
  if (e instanceof IvoraError)
    console.error(
      `cpo-starter-kit: checkout ${what} failed:`,
      `${e.code} (HTTP ${e.status}) ${e.requestId ?? ""} ${record ?? ""}`.trim(),
    );
}

/**
 * Reads several page views share: a charger's status for a few seconds, the Stripe
 * account for a minute, an example quote for 15 minutes. A public page can't then
 * spend the operator's Ivora rate limit, however often it is opened. Errors are not
 * kept.
 */
async function cached<T>(
  d: CheckoutDeps,
  key: string,
  ms: number,
  read: () => Promise<T>,
): Promise<T> {
  const hit = d.cache.get(key);
  if (hit && hit.until > now(d)) return hit.value as T;
  const value = await read();
  d.cache.set(key, { until: now(d) + ms, value });
  if (d.cache.size > 500)
    for (const [k, v] of d.cache) if (v.until <= now(d)) d.cache.delete(k);
  return value;
}

// ---- What a connector can do ----

/** Connector statuses a paid start may go to: free, or a driver has plugged in. */
const READY = new Set(["Available", "Preparing"]);
const IN_USE = new Set([
  "Charging",
  "SuspendedEV",
  "SuspendedEVSE",
  "Finishing",
  "Occupied",
  "Reserved",
]);

export interface ConnectorState {
  /** As the charger reports it; null when unknown. */
  status: string | null;
  /** What stops a checkout, or null. */
  blocked: "offline" | "in_use" | "out_of_order" | null;
  maxPowerKw: number | null;
}

export function connectorState(
  station: Station,
  connectorId: number,
): ConnectorState {
  const c = station.connectors.find((x) => x.id === connectorId);
  const status = c?.status ?? null;
  return {
    status,
    blocked: !station.online
      ? "offline"
      : status && READY.has(status)
        ? null
        : status && IN_USE.has(status)
          ? "in_use"
          : "out_of_order",
    maxPowerKw: c?.max_power_w ? Math.round(c.max_power_w / 100) / 10 : null,
  };
}

function blockedError(
  blocked: NonNullable<ConnectorState["blocked"]>,
  status: string | null,
): CheckoutError {
  switch (blocked) {
    case "offline":
      return new CheckoutError(
        "offline",
        "This charger is offline right now, so it can't start. Use another charger, or try again in a few minutes.",
      );
    case "in_use":
      return new CheckoutError(
        "in_use",
        "This connector is in use. Wait until it is free, or use another one. Nothing was charged.",
      );
    case "out_of_order":
      return new CheckoutError(
        "out_of_order",
        `This connector can't charge right now${status ? ` (it reports "${status}")` : ""}. Use another one, or contact the operator.`,
      );
  }
}

const stripeNotReady = (operator: string, apiCode?: string) =>
  new CheckoutError(
    "stripe_not_ready",
    `${operator} can't take card payments here yet. Nothing was charged. Please contact them, or use another way to start charging.`,
    apiCode,
  );

// ---- The page ----

export interface QuoteLineView {
  label: string;
  amount: string;
}

export interface ChargePage {
  state: "unknown" | "not_in_service" | "open";
  code: string;
  operatorName: string | null;
  chargerName: string | null;
  connectorNumber: number | null;
  /** Why "Pay and charge" is off, or null when it is on. */
  closed: { code: CheckoutErrorCode; message: string } | null;
  tariffName: string | null;
  /** The tariff's text for drivers (its price description). */
  priceText: string | null;
  hold: string | null;
  connector: ConnectorState | null;
  /** Ivora's quote of the example session under the connector's tariff. */
  example: { lines: QuoteLineView[]; total: string } | null;
  /** Why the status or quote could not be read, for the page. */
  readError: string | null;
}

interface Resolved {
  found: ResolvedCode & { stationId: number; connectorId: number };
  def: TariffDefinition;
  tariffName: string;
  ivoraTariffId: number;
  operatorName: string;
}

/**
 * The sticker, its connector and price, or why it can't be paid for. Private chargers,
 * free tariffs (Ivora Checkout needs a card hold of at least $0.50) and connectors with
 * no tariff are closed before anything is asked of Ivora.
 */
async function resolve(
  d: CheckoutDeps,
  rawCode: string,
  operatorName: string,
): Promise<
  | { ok: true; r: Resolved }
  | { ok: false; error: CheckoutError; found: ResolvedCode | null }
> {
  const code = rawCode.toUpperCase();
  const found = isStickerCode(code) ? await d.chargers.resolveCode(code) : null;
  const fail = (error: CheckoutError) => ({ ok: false as const, error, found });
  if (!found)
    return fail(
      new CheckoutError(
        "not_found",
        "This sticker code is not known here. Please contact the site operator.",
      ),
    );
  const name = found.operatorName ?? operatorName;
  if (!found.inService || found.stationId === null)
    return fail(
      new CheckoutError(
        "not_in_service",
        "This charger is not in service. Please use another one, or contact the site operator.",
      ),
    );
  if (found.connectorId === null)
    return fail(
      new CheckoutError(
        "no_price",
        `This connector is not set up for payment yet. Please contact ${name}.`,
      ),
    );
  const state = await d.pricing.load(found.operatorId);
  if (state.stations.find((s) => s.stationId === found.stationId)?.private)
    return fail(
      new CheckoutError(
        "private",
        "This is a private charger: it can't be paid for here. Staff and RFID card holders start it with their card.",
      ),
    );
  const e = effectiveTariff(state, found.stationId, found.connectorId);
  const def = e?.version.definition ?? null;
  if (!e || !def || e.version.ivoraTariffId === null)
    return fail(
      new CheckoutError(
        "no_price",
        `This connector has no price yet, so it can't be paid for here. Please contact ${name}.`,
      ),
    );
  if (def.kind === "free")
    return fail(
      new CheckoutError(
        "free",
        `Charging here is free, but it can't be started from this page: card checkout needs a paid price. Start it with your RFID card, or ask ${name}.`,
      ),
    );
  return {
    ok: true,
    r: {
      found: found as Resolved["found"],
      def,
      tariffName: e.tariff.name,
      ivoraTariffId: e.version.ivoraTariffId,
      operatorName: name,
    },
  };
}

const LINE_LABELS: Record<string, string> = {
  ENERGY: "Energy",
  FLAT: "Session fee",
  PARKING_TIME: "Idle fee",
  TIME: "Charging time",
};

function exampleView(q: Quote) {
  return {
    lines: q.lines.map((l) => ({
      label:
        l.type === "ENERGY"
          ? `${LINE_LABELS.ENERGY}, ${Number(l.quantity)} kWh`
          : (LINE_LABELS[l.type] ?? l.type),
      amount: formatMinor(l.amount_minor, q.currency),
    })),
    total: formatMinor(q.total_minor, q.currency),
  };
}

/** The public page behind a sticker: `/c/<code>`. */
export async function loadChargePage(
  d: CheckoutDeps,
  rawCode: string,
  defaultOperatorName: string,
): Promise<ChargePage> {
  const code = rawCode.toUpperCase().slice(0, 16);
  const res = await resolve(d, code, defaultOperatorName);
  const base: ChargePage = {
    state: "open",
    code,
    operatorName: null,
    chargerName: null,
    connectorNumber: null,
    closed: null,
    tariffName: null,
    priceText: null,
    hold: null,
    connector: null,
    example: null,
    readError: null,
  };
  if (!res.ok) {
    const f = res.found;
    return {
      ...base,
      state:
        res.error.code === "not_found"
          ? "unknown"
          : res.error.code === "not_in_service"
            ? "not_in_service"
            : "open",
      operatorName: f ? (f.operatorName ?? defaultOperatorName) : null,
      chargerName: f?.chargerName ?? null,
      connectorNumber: f?.connectorNumber ?? null,
      closed: { code: res.error.code, message: res.error.message },
    };
  }
  const { found, def, operatorName } = res.r;
  const view: ChargePage = {
    ...base,
    operatorName,
    chargerName: found.chargerName,
    connectorNumber: found.connectorNumber,
    tariffName: res.r.tariffName,
    priceText: driverText(def),
    hold: formatMinor(holdMinor(def), def.currency),
  };
  const errors: string[] = [];
  const t = now(d);
  const [station, account, quote] = await Promise.allSettled([
    cached(d, `station:${found.stationId}`, 5_000, () =>
      d.ivora.getStation(found.stationId),
    ),
    cached(d, "account", 60_000, () => d.ivora.getPaymentAccount()),
    cached(
      d,
      `quote:${res.r.ivoraTariffId}:${Math.floor(t / 900_000)}`,
      900_000,
      () =>
        d.ivora.quoteTariff(res.r.ivoraTariffId, {
          start_at: new Date(Math.floor(t / 60_000) * 60_000).toISOString(),
          time_zone: def.timeZone,
          duration_minutes: EXAMPLE_SESSION.minutes,
          energy_kwh: EXAMPLE_SESSION.energyKwh,
          idle_minutes: 0,
        }),
    ),
  ]);
  if (station.status === "fulfilled") {
    view.connector = connectorState(station.value, found.connectorId);
    if (view.connector.blocked) {
      const e = blockedError(view.connector.blocked, view.connector.status);
      view.closed = { code: e.code, message: e.message };
    }
  } else {
    log("status read", station.reason);
    errors.push("The charger's status can't be read right now.");
  }
  if (
    account.status === "fulfilled" &&
    stripeView(account.value).state !== "ready" &&
    !view.closed
  ) {
    const e = stripeNotReady(operatorName);
    view.closed = { code: e.code, message: e.message };
  } else if (account.status === "rejected") log("account read", account.reason);
  if (quote.status === "fulfilled") view.example = exampleView(quote.value);
  else {
    log("quote", quote.reason);
    errors.push("The example price can't be shown right now.");
  }
  view.readError = errors.length ? errors.join(" ") : null;
  return view;
}

// ---- Pay and charge ----

/** A 4xx that says Ivora did nothing (not a timeout, a rate limit or "in progress"). */
function definite(e: IvoraError): boolean {
  return (
    e.status >= 400 &&
    e.status < 500 &&
    e.status !== 408 &&
    e.status !== 429 &&
    e.code !== "request_in_progress"
  );
}

/** What a refusal from Ivora means for the driver. */
function refusal(e: IvoraError, operator: string): CheckoutError {
  switch (e.code) {
    case "payment_account_required":
    case "payment_account_not_ready":
      return stripeNotReady(operator, e.code);
    case "station_offline":
      return new CheckoutError(
        "offline",
        blockedError("offline", null).message,
        e.code,
        e.requestId,
      );
    case "connector_occupied":
    case "transaction_active":
      return new CheckoutError(
        "in_use",
        blockedError("in_use", null).message,
        e.code,
        e.requestId,
      );
    case "tariff_archived":
    case "tariff_not_found":
      return new CheckoutError(
        "refused",
        "The price of this charger changed a moment ago. Reload the page to see the new price. Nothing was charged.",
        e.code,
        e.requestId,
      );
    default:
      return new CheckoutError(
        "refused",
        `The payment service refused this checkout: ${e.message}. Nothing was charged. Reload the page to try again, or contact ${operator}.`,
        e.code,
        e.requestId,
      );
  }
}

const unconfirmed = (e: IvoraError) =>
  new CheckoutError(
    "unconfirmed",
    "The payment service didn't answer in time. Tap “Pay and charge” again: it continues the same checkout, so you can't be charged twice.",
    e.code,
    e.requestId,
  );

const keyFor = (id: string, action: "bill" | "payment" | "start") =>
  idempotencyKey("checkout", id, action);

/**
 * The hosted checkout to send the driver to, from the payment's next_action: an https
 * URL (Stripe's redirect_to_url shape or a plain `url`). The demo client's stands in
 * with the kit's own /demo/checkout/ page. Anything else is refused, so a malformed
 * answer can never redirect a driver somewhere unexpected.
 */
export function checkoutUrl(
  p: Pick<Payment, "next_action">,
  mode: IvoraClient["mode"],
): string | null {
  const a = p.next_action;
  const nested = a?.redirect_to_url;
  const raw =
    (nested && typeof nested === "object"
      ? (nested as Record<string, unknown>).url
      : undefined) ??
    a?.url ??
    a?.checkout_url;
  if (typeof raw !== "string" || raw.length > 2048) return null;
  if (mode === "demo")
    return /^\/demo\/checkout\/[A-Za-z0-9_-]+$/.test(raw) ? raw : null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}

async function take(
  d: CheckoutDeps,
  name: keyof typeof CHECKOUT_LIMITS,
  subject: string | null,
) {
  if (subject === null) return;
  const { quota, periodSeconds } = CHECKOUT_LIMITS[name];
  if (
    !(await d.limiter.take(
      `checkout-${name}:${digest(d.secret, subject)}`,
      quota,
      periodSeconds,
    ))
  )
    throw new CheckoutError(
      "rate_limited",
      "Too many checkouts were started here just now. Wait a few minutes and try again.",
    );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Pay and charge": checks the connector and the Stripe account, then creates a bill
 * (`POST /bills`, key cpo-checkout-<id>-bill) and a hosted payment with
 * `return_surface: driver` and `return_reference: <id>` (`POST /payment/stripe/…/
 * payments`, key cpo-checkout-<id>-payment), and returns the URL to send the driver
 * to. The checkout record is claimed first by the form's request ID, so a double tap or
 * a retry after an uncertain answer continues the same checkout with the same keys:
 * one bill, one payment. Only a definite refusal fails it.
 */
export async function payAndCharge(
  d: CheckoutDeps,
  input: { code: string; requestId: string; source: string | null },
  defaultOperatorName: string,
): Promise<{ id: string; url: string }> {
  if (!UUID.test(input.requestId))
    throw new CheckoutError("invalid", "Reload the page and try again.");
  const res = await resolve(d, input.code, defaultOperatorName);
  if (!res.ok) throw res.error;
  const { found, def, operatorName } = res.r;
  await take(d, "source", input.source);
  await take(d, "connector", `${found.operatorId}:${found.connectorId}`);
  await take(d, "operator", found.operatorId);

  const { id } = await d.store.claim({
    operatorId: found.operatorId,
    requestId: input.requestId.toLowerCase(),
    stickerCode: found.code,
    stationId: found.stationId,
    connectorId: found.connectorId,
    tariffId: res.r.ivoraTariffId,
    holdMinor: holdMinor(def),
    currency: def.currency,
  });
  let rec = (await d.store.get(found.operatorId, id))!;
  const record = async (changes: Parameters<CheckoutStore["record"]>[2]) => {
    await d.store.record(found.operatorId, id, changes);
    rec = (await d.store.get(found.operatorId, id))!;
  };
  const fail = async (e: CheckoutError) => {
    await record({
      phase: "failed",
      error: `${e.apiCode ? `${e.apiCode}: ` : ""}${e.message}`,
    });
    return e;
  };

  if (rec.phase === "failed")
    throw new CheckoutError(
      "refused",
      `${rec.error ?? "This checkout did not go through."} Reload the page to start again.`,
    );
  if (rec.phase === "checkout" && rec.checkoutUrl) {
    if (now(d) - Date.parse(rec.createdAt) > CHECKOUT_REUSE_MINUTES * 60_000)
      throw new CheckoutError(
        "expired",
        "This payment page has expired. Reload the page to start again. Nothing was charged.",
      );
    return { id, url: rec.checkoutUrl };
  }

  // Before any bill: is the connector free, and can the operator take card payments?
  if (!rec.billId) {
    let station: Station;
    let ready: boolean;
    try {
      station = await d.ivora.getStation(found.stationId);
      ready = stripeView(await d.ivora.getPaymentAccount()).state === "ready";
    } catch (e) {
      if (!(e instanceof IvoraError)) throw e;
      log("check", e, id);
      throw new CheckoutError(
        "unavailable",
        "The charger can't be checked right now. Try again in a minute. Nothing was charged.",
        e.code,
        e.requestId,
      );
    }
    const state = connectorState(station, found.connectorId);
    if (state.blocked)
      throw await fail(blockedError(state.blocked, state.status));
    if (!ready) throw await fail(stripeNotReady(operatorName));
  }

  if (!rec.billId) {
    let bill: Bill;
    try {
      bill = await d.ivora.createBill(
        {
          station_id: found.stationId,
          connector_id: found.connectorId,
          tariff_id: res.r.ivoraTariffId,
        },
        keyFor(id, "bill"),
      );
    } catch (e) {
      if (!(e instanceof IvoraError)) throw e;
      log("bill", e, id);
      if (definite(e)) throw await fail(refusal(e, operatorName));
      throw unconfirmed(e);
    }
    await record({ billId: bill.id, error: null });
  }

  let payment: Payment;
  try {
    payment = await d.ivora.createPayment(
      {
        bill_id: rec.billId!,
        return_surface: "driver",
        return_reference: id,
      },
      keyFor(id, "payment"),
    );
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    log("payment", e, id);
    if (definite(e)) throw await fail(refusal(e, operatorName));
    throw unconfirmed(e);
  }
  const url = checkoutUrl(payment, d.ivora.mode);
  if (!url) {
    if (payment.status === "canceled")
      throw await fail(
        new CheckoutError(
          "expired",
          "This payment page has expired. Reload the page to start again. Nothing was charged.",
        ),
      );
    console.error(
      `cpo-starter-kit: checkout payment ${payment.status} without a checkout URL ${id}`,
    );
    throw new CheckoutError(
      "unconfirmed",
      `The payment service did not return a payment page (payment ${payment.status}). Tap “Pay and charge” again, or contact ${operatorName}.`,
    );
  }
  await record({
    paymentId: payment.id,
    checkoutUrl: url,
    phase: "checkout",
    error: null,
  });
  return { id, url };
}

// ---- A driver back on the sticker's page ----

/** What each step of a paid session means for the driver. */
export const PROGRESS: Record<BillProgress, { label: string; detail: string }> =
  {
    awaiting_payment: {
      label: "Waiting for payment",
      detail:
        "The card hold is not confirmed yet. Finish paying on the payment page, or tap “Pay and charge” to open it again.",
    },
    authorized: {
      label: "Paid, not started",
      detail:
        "Your card hold is in place, but the charger did not start by itself. Plug in and tap “Start charging”.",
    },
    starting: { label: "Starting", detail: "The charger is being started." },
    waiting_for_vehicle: {
      label: "Plug in your car",
      detail:
        "The charger is ready. Charging starts when your car is plugged in.",
    },
    charging: { label: "Charging", detail: "Your car is charging." },
    ended: {
      label: "Finished",
      detail:
        "This session has ended. Your receipt is on the payment service's page.",
    },
    start_failed: {
      label: "Didn't start",
      detail:
        "The charger did not confirm the start. Please contact the operator before trying again, so you aren't charged twice.",
    },
    canceled: {
      label: "Canceled",
      detail:
        "The payment was canceled or expired before charging. Nothing was charged.",
    },
  };

export interface DriverSession {
  id: string;
  createdAt: string;
  label: string;
  detail: string;
  progress: BillProgress | null;
  energyKwh: string | null;
  estimate: string | null;
  canStart: boolean;
}

const kwh = (wh: number) => (Math.round(wh / 10) / 100).toFixed(2);

function sessionView(rec: CheckoutRecord, bill: Bill | null): DriverSession {
  const progress = bill?.progress ?? null;
  const p = progress
    ? PROGRESS[progress]
    : rec.phase === "failed"
      ? { label: "Not started", detail: rec.error ?? "Nothing was charged." }
      : {
          label: "Not confirmed",
          detail:
            "The payment page was not opened. Tap “Pay and charge” to try again.",
        };
  const usage = bill?.usage;
  return {
    id: rec.id,
    createdAt: rec.createdAt,
    label: p.label,
    detail: p.detail,
    progress,
    energyKwh:
      usage?.energy_wh !== null && usage?.energy_wh !== undefined
        ? kwh(usage.energy_wh)
        : null,
    estimate:
      typeof usage?.estimated_minor === "number"
        ? formatMinor(usage.estimated_minor, rec.currency)
        : null,
    canStart: progress === "authorized",
  };
}

/** The driver's own recent checkouts at this sticker (IDs from their browser's cookie). */
async function ownCheckouts(
  d: CheckoutDeps,
  operatorId: string,
  code: string,
  ids: string[],
): Promise<CheckoutRecord[]> {
  const out: CheckoutRecord[] = [];
  for (const id of ids.filter((x) => UUID.test(x)).slice(0, 3)) {
    const r = await d.store.get(operatorId, id);
    if (
      r &&
      r.stickerCode === code &&
      now(d) - Date.parse(r.createdAt) < DRIVER_SESSION_HOURS * 3_600_000
    )
      out.push(r);
  }
  return out;
}

/**
 * The returning driver's sessions at this sticker, newest first. Reading a
 * driver-return bill is also what lets Ivora start the charger once the hold is
 * authorized (the documented driver-return rule), so this read is part of the flow.
 */
export async function driverSessions(
  d: CheckoutDeps,
  rawCode: string,
  ids: string[],
): Promise<DriverSession[]> {
  const code = rawCode.toUpperCase();
  if (!ids.length || !isStickerCode(code)) return [];
  const found = await d.chargers.resolveCode(code);
  if (!found) return [];
  const recs = await ownCheckouts(d, found.operatorId, code, ids);
  const out: DriverSession[] = [];
  for (const r of recs) {
    let bill: Bill | null = null;
    if (r.phase === "checkout" && r.billId)
      try {
        bill = await d.ivora.getBill(r.billId);
      } catch (e) {
        if (!(e instanceof IvoraError)) throw e;
        log("bill read", e, r.id);
      }
    out.push(sessionView(r, bill));
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Starts a paid bill whose automatic start Ivora refused (`progress` authorized, for
 * example because the charger was offline when the driver came back). Only the browser
 * that made the checkout can ask (its ID is in their cookie). The key is fixed per
 * checkout, and Ivora answers any later start of the bill with its one start
 * operation, so the charger is never started twice.
 */
export async function startPaidSession(
  d: CheckoutDeps,
  input: { code: string; id: string; ids: string[] },
  defaultOperatorName: string,
): Promise<void> {
  const code = input.code.toUpperCase();
  const found = isStickerCode(code) ? await d.chargers.resolveCode(code) : null;
  if (!found || !input.ids.includes(input.id))
    throw new CheckoutError("not_found", "Reload the page and try again.");
  const [rec] = await ownCheckouts(d, found.operatorId, code, [input.id]);
  if (!rec?.billId || rec.phase !== "checkout")
    throw new CheckoutError("not_found", "Reload the page and try again.");
  const operator = found.operatorName ?? defaultOperatorName;
  try {
    const bill = await d.ivora.getBill(rec.billId);
    if (bill.progress !== "authorized")
      throw new CheckoutError(
        "invalid",
        bill.progress === "awaiting_payment"
          ? "Your payment isn't confirmed yet. Finish paying first."
          : "This session has already started or ended. Reload the page.",
      );
    await d.ivora.startBill(rec.billId, keyFor(rec.id, "start"));
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    log("start", e, rec.id);
    if (definite(e)) throw refusal(e, operator);
    throw new CheckoutError(
      "unconfirmed",
      "The charger didn't confirm the start yet. Wait a moment and reload the page before trying again.",
      e.code,
      e.requestId,
    );
  }
  await d.store.record(found.operatorId, rec.id, { startRequested: true });
}
