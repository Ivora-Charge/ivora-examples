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
  type Operation,
  type Payment,
  type Quote,
  type Station,
  type Transaction,
} from "../ivora";
import {
  ensureFreeToken,
  isFreeSession,
  running,
  STARTABLE,
} from "../live/service";
import type { LiveStore } from "../live/types";
import { stripeView } from "../onboarding/stripe";
import { effectiveTariff } from "../pricing/service";
import { driverText } from "../pricing/tariff";
import type { PricingStore, TariffDefinition } from "../pricing/types";
import { digest, type RateLimiter } from "../rate-limit";
import {
  CheckoutError,
  HOLDS_CONNECTOR,
  UNSETTLED,
  type CheckoutChanges,
  type CheckoutErrorCode,
  type CheckoutKind,
  type CheckoutRecord,
  type CheckoutStore,
} from "./types";

// Driver checkout, shared by demo and live mode. Drivers are not staff: the sticker's
// code is the only thing they bring, so every check (charger, connector, price,
// private, Stripe) happens here on the server before Ivora is asked for anything. The
// money goes through Ivora Checkout to the operator's own Stripe account: the kit
// holds no Stripe keys and never sees a card. Ivora never finalizes or captures a bill
// by itself, so settlement (stop near the hold, finalize, capture, release) is here
// too. Logs carry codes and record IDs only.

export interface CheckoutDeps {
  store: CheckoutStore;
  ivora: IvoraClient;
  chargers: Pick<ChargerStore, "resolveCode">;
  pricing: Pick<PricingStore, "load">;
  /** Where the operator's free charging token is kept (the Live view's store). */
  tokens: Pick<LiveStore, "getFreeToken" | "putFreeToken">;
  limiter: RateLimiter;
  /** Keys the rate-limit digests, so sources and connectors are never stored plain. */
  secret: string;
  /** Short-lived reads shared by page views (see `cached`). */
  cache: Map<string, { until: number; value: unknown }>;
  now?: () => number;
}

/**
 * How long a driver has to pay. Tapping "Pay and charge" again within it reopens the
 * same payment page; after it the payment is released and the connector is free for
 * the next driver.
 */
export const PAYMENT_WINDOW_MINUTES = 15;
/** A paid checkout that never started is released this long after it was made. */
export const UNSTARTED_RELEASE_MINUTES = 30;
/**
 * A tap whose bill, payment or free start was never confirmed: after this the kit
 * closes it (no payment page was ever handed out, so no hold can exist).
 */
export const CREATING_STALE_MINUTES = 5;
/**
 * Ivora keeps a dispatched start's charging token 15 minutes and allows release 20
 * minutes after dispatch, when no session matched.
 */
export const START_RESERVED_MINUTES = 20;
/** A free start with no session after this frees the connector again. */
export const FREE_START_WAIT_MINUTES = 5;
/**
 * The kit stops a paid session once Ivora's estimate reaches this share of the hold,
 * so the final bill (which can't exceed the hold) is always covered. The rest is room
 * for the energy delivered between two checks (see the README: check every minute).
 */
export const HOLD_STOP_PERCENT = 90;
/** Settlement that still fails after this goes to the operator (attention). */
const GIVE_UP_HOURS = 24;
/** A returning driver's sessions are shown on the sticker's page this long. */
export const DRIVER_SESSION_HOURS = 12;
/** Ivora Checkout's authorization limits ($0.50 to $100), integer minor units. */
const HOLD_RANGE = { min: 50, max: 10_000 } as const;

/**
 * Checkout quotas. Per source, per source and connector (so one person can't block a
 * connector), and a total per operator. Without a trusted client address (see sourceOf)
 * a per-connector cap stands in for the per-source ones.
 */
export const CHECKOUT_LIMITS = {
  source: { quota: 10, periodSeconds: 600 },
  sourceConnector: { quota: 4, periodSeconds: 3600 },
  connector: { quota: 20, periodSeconds: 3600 },
  operator: { quota: 300, periodSeconds: 3600 },
} as const;

/** The example session the page prices with Ivora's quote: 20 kWh over an hour. */
export const EXAMPLE_SESSION = { energyKwh: 20, minutes: 60 } as const;

const now = (d: CheckoutDeps) => (d.now ?? Date.now)();
const minutes = (n: number) => n * 60_000;
const ageOf = (d: CheckoutDeps, iso: string) => now(d) - Date.parse(iso);

function log(what: string, e: unknown, record?: string) {
  if (e instanceof IvoraError)
    console.error(
      `cpo-starter-kit: checkout ${what} failed:`,
      `${e.code} (HTTP ${e.status}) ${e.requestId ?? ""} ${record ?? ""}`.trim(),
    );
}

/**
 * Reads several page views share: a charger's status for a few seconds, the Stripe
 * account for a minute, a tariff's hold and an example quote for 15 minutes. A public
 * page can't then spend the operator's Ivora rate limit, however often it is opened.
 * Errors are not kept.
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

/** Connector statuses a paid checkout may begin at: free, or a driver has plugged in. */
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
        "This charger is offline right now, so it can't start. Use another charger, or try again in a few minutes. Nothing was charged.",
      );
    case "in_use":
      return new CheckoutError(
        "in_use",
        "This connector is in use. Wait until it is free, or use another one. Nothing was charged.",
      );
    case "out_of_order":
      return new CheckoutError(
        "out_of_order",
        `This connector can't charge right now${status ? ` (it reports "${status}")` : ""}. Use another one, or contact the operator. Nothing was charged.`,
      );
  }
}

const heldByOther = () =>
  new CheckoutError(
    "in_use",
    "Another driver is paying for or using this connector right now. Wait until it is free, or use another one. Nothing was charged.",
  );

const stripeNotReady = (operator: string, apiCode?: string) =>
  new CheckoutError(
    "stripe_not_ready",
    `${operator} can't take card payments here yet. Nothing was charged. Please contact them, or use another way to start charging.`,
    apiCode,
  );

const notFree = () =>
  new CheckoutError(
    "not_free",
    "This connector isn't free to use any more: its price changed. Reload the page to see the price. Nothing was started.",
  );

// ---- The sticker, its connector and price ----

interface Resolved {
  found: ResolvedCode & { stationId: number; connectorId: number };
  def: TariffDefinition;
  tariffName: string;
  ivoraTariffId: number;
  operatorName: string;
  kind: CheckoutKind;
}

/**
 * The sticker, its connector and its price right now, or why it can't be used.
 * Private chargers and connectors with no tariff are closed before anything is asked
 * of Ivora. A free tariff (no charge at all) is a free session; anything else is paid.
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
        "This is a private charger: it can't be started here. Staff and RFID card holders start it with their card.",
      ),
    );
  const e = effectiveTariff(state, found.stationId, found.connectorId);
  const def = e?.version.definition ?? null;
  if (!e || !def || e.version.ivoraTariffId === null)
    return fail(
      new CheckoutError(
        "no_price",
        `This connector has no price yet, so it can't be started here. Please contact ${name}.`,
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
      kind: def.kind === "free" ? "free" : "paid",
    },
  };
}

/** The card hold of an Ivora tariff (its authorization_minor), or null if unusable. */
async function tariffHold(
  d: CheckoutDeps,
  tariffId: number,
): Promise<number | null> {
  const t = await cached(d, `tariff:${tariffId}`, minutes(15), () =>
    d.ivora.getTariff(tariffId),
  );
  const h = t.authorization_minor;
  return Number.isInteger(h) && h >= HOLD_RANGE.min && h <= HOLD_RANGE.max
    ? h
    : null;
}

// ---- The page ----

export interface QuoteLineView {
  label: string;
  amount: string;
}

export interface ChargePage {
  state: "unknown" | "not_in_service" | "open";
  code: string;
  /** paid: "Pay and charge"; free: "Start free session". Null when unknown. */
  kind: CheckoutKind | null;
  operatorName: string | null;
  chargerName: string | null;
  connectorNumber: number | null;
  /** Why the start button is off, or null when it is on. */
  closed: { code: CheckoutErrorCode; message: string } | null;
  /** This browser already has a waiting or running session on this connector. */
  mine: boolean;
  tariffName: string | null;
  /** The tariff's text for drivers (its price description). */
  priceText: string | null;
  /** The card hold, from the Ivora tariff (paid only). */
  hold: string | null;
  connector: ConnectorState | null;
  /** Ivora's quote of the example session under the connector's tariff (paid). */
  example: { lines: QuoteLineView[]; total: string } | null;
  /** Why the status, hold or quote could not be read, for the page. */
  readError: string | null;
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

/** The checkout holding a connector right now, if any. */
async function holder(
  d: CheckoutDeps,
  operatorId: string,
  stationId: number,
  connectorId: number,
): Promise<CheckoutRecord | null> {
  return (
    (await d.store.listUnsettled({ stationId, limit: 20 })).find(
      (r) =>
        r.operatorId === operatorId &&
        r.connectorId === connectorId &&
        HOLDS_CONNECTOR.has(r.phase),
    ) ?? null
  );
}

/**
 * The public page behind a sticker: `/c/<code>`. `ownRequests` are the taps this
 * browser made (its cookie): their session doesn't count as someone else's.
 */
export async function loadChargePage(
  d: CheckoutDeps,
  rawCode: string,
  defaultOperatorName: string,
  ownRequests: string[] = [],
): Promise<ChargePage> {
  const code = rawCode.toUpperCase().slice(0, 16);
  const res = await resolve(d, code, defaultOperatorName);
  const base: ChargePage = {
    state: "open",
    code,
    kind: null,
    operatorName: null,
    chargerName: null,
    connectorNumber: null,
    closed: null,
    mine: false,
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
  const { found, def, operatorName, kind } = res.r;
  const view: ChargePage = {
    ...base,
    kind,
    operatorName,
    chargerName: found.chargerName,
    connectorNumber: found.connectorNumber,
    tariffName: res.r.tariffName,
    priceText: driverText(def),
  };
  const close = (e: CheckoutError) => {
    view.closed ??= { code: e.code, message: e.message };
  };
  const errors: string[] = [];
  const t = now(d);
  const paid = kind === "paid";
  const [station, account, quote, hold, held] = await Promise.allSettled([
    cached(d, `station:${found.stationId}`, 5_000, () =>
      d.ivora.getStation(found.stationId),
    ),
    paid
      ? cached(d, "account", 60_000, () => d.ivora.getPaymentAccount())
      : Promise.resolve(null),
    paid
      ? cached(
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
        )
      : Promise.resolve(null),
    paid ? tariffHold(d, res.r.ivoraTariffId) : Promise.resolve(null),
    holder(d, found.operatorId, found.stationId, found.connectorId),
  ]);
  if (held.status === "fulfilled" && held.value) {
    const own = ownRequests.includes(held.value.requestId);
    view.mine = own;
    close(
      own
        ? new CheckoutError(
            "in_use",
            "You already have a session on this connector: see “Your session” above.",
          )
        : heldByOther(),
    );
  }
  if (station.status === "fulfilled") {
    view.connector = connectorState(station.value, found.connectorId);
    // A free start goes only to an Available connector (as staff remote starts do).
    if (
      !paid &&
      !view.connector.blocked &&
      !STARTABLE.has(view.connector.status ?? "")
    )
      view.connector.blocked = "in_use";
    if (view.connector.blocked)
      close(blockedError(view.connector.blocked, view.connector.status));
  } else {
    log("status read", station.reason);
    errors.push("The charger's status can't be read right now.");
  }
  if (paid) {
    if (account.status === "fulfilled" && account.value) {
      if (stripeView(account.value).state !== "ready")
        close(stripeNotReady(operatorName));
    } else if (account.status === "rejected")
      log("account read", account.reason);
    if (hold.status === "fulfilled") {
      if (hold.value === null)
        close(
          new CheckoutError(
            "no_price",
            `This connector's price has no usable card hold, so it can't be paid for here. Please contact ${operatorName}.`,
          ),
        );
      else view.hold = formatMinor(hold.value, def.currency);
    } else {
      log("tariff read", hold.reason);
      errors.push("The card hold can't be read right now.");
    }
    if (quote.status === "fulfilled" && quote.value)
      view.example = exampleView(quote.value);
    else if (quote.status === "rejected") {
      log("quote", quote.reason);
      errors.push("The example price can't be shown right now.");
    }
  }
  view.readError = errors.length ? errors.join(" ") : null;
  return view;
}

// ---- Ivora's answers ----

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
        `The payment service refused this: ${e.message}. Nothing was charged. Reload the page to try again, or contact ${operator}.`,
        e.code,
        e.requestId,
      );
  }
}

const unconfirmed = (e: IvoraError, again: string) =>
  new CheckoutError(
    "unconfirmed",
    `The payment service didn't answer in time. Tap “${again}” again: it continues the same session, so nothing happens twice.`,
    e.code,
    e.requestId,
  );

type KeyAction =
  | "bill"
  | "payment"
  | "start"
  | "stop"
  | "hold-stop"
  | "finalize"
  | "capture"
  | "release";
const keyFor = (id: string, action: KeyAction) =>
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
  subject: string,
) {
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
      "Too many sessions were started here just now. Wait a few minutes and try again. Nothing was charged.",
    );
}

/** Per source, per source and connector, a total per operator (see CHECKOUT_LIMITS). */
async function takeLimits(
  d: CheckoutDeps,
  found: Resolved["found"],
  source: string | null,
) {
  const connector = `${found.operatorId}:${found.connectorId}`;
  if (source !== null) {
    await take(d, "source", source);
    await take(d, "sourceConnector", `${source}|${connector}`);
  } else await take(d, "connector", connector);
  await take(d, "operator", found.operatorId);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Claims the connector for this tap. When another checkout holds it, that one is
 * settled first (it may have ended or expired), then the claim is tried once more.
 */
async function claimConnector(
  d: CheckoutDeps,
  n: Parameters<CheckoutStore["claim"]>[0],
): Promise<string> {
  for (let i = 0; i < 2; i++) {
    const c = await d.store.claim(n);
    if (c.busy === undefined) return c.id;
    const other = await d.store.get(n.operatorId, c.busy);
    if (i === 0 && other) await settleCheckout(d, other);
  }
  throw heldByOther();
}

const closedMessage = (rec: CheckoutRecord) =>
  `${rec.error ?? "This session did not go through."} Reload the page to start again.`;

/**
 * "Pay and charge": checks the connector and the Stripe account, claims the connector
 * (one waiting or running checkout per connector, before any hold), then creates a bill
 * (`POST /bills`, key cpo-checkout-<id>-bill) and a hosted payment with
 * `return_surface: driver` and `return_reference: <reference>` (key
 * cpo-checkout-<id>-payment), and returns the URL to send the driver to. A double tap
 * or a retry after an uncertain answer continues the same checkout with the same keys:
 * one bill, one payment. Only a definite refusal fails it.
 */
export async function payAndCharge(
  d: CheckoutDeps,
  input: { code: string; requestId: string; source: string | null },
  defaultOperatorName: string,
): Promise<{ requestId: string; url: string }> {
  if (!UUID.test(input.requestId))
    throw new CheckoutError("invalid", "Reload the page and try again.");
  const requestId = input.requestId.toLowerCase();
  const res = await resolve(d, input.code, defaultOperatorName);
  if (!res.ok) throw res.error;
  const { found, def, operatorName } = res.r;
  if (res.r.kind === "free")
    throw new CheckoutError(
      "free",
      "Charging here is free: no payment is needed. Reload the page and tap “Start free session”.",
    );

  let rec = await d.store.getByRequest(found.operatorId, requestId);
  if (!rec) {
    await takeLimits(d, found, input.source);
    let hold: number | null;
    try {
      hold = await tariffHold(d, res.r.ivoraTariffId);
    } catch (e) {
      if (!(e instanceof IvoraError)) throw e;
      log("tariff read", e);
      throw new CheckoutError(
        "unavailable",
        "The price can't be checked right now. Try again in a minute. Nothing was charged.",
        e.code,
        e.requestId,
      );
    }
    if (hold === null)
      throw new CheckoutError(
        "no_price",
        `This connector's price has no usable card hold, so it can't be paid for here. Please contact ${operatorName}.`,
      );
    const id = await claimConnector(d, {
      operatorId: found.operatorId,
      requestId,
      kind: "paid",
      stickerCode: found.code,
      stationId: found.stationId,
      connectorId: found.connectorId,
      tariffId: res.r.ivoraTariffId,
      holdMinor: hold,
      currency: def.currency,
    });
    rec = (await d.store.get(found.operatorId, id))!;
  }
  if (rec.kind !== "paid" || rec.stickerCode !== found.code)
    throw new CheckoutError("invalid", "Reload the page and try again.");
  const id = rec.id;
  const record = async (changes: CheckoutChanges) => {
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

  if (rec.phase === "open" && rec.checkoutUrl) {
    if (ageOf(d, rec.createdAt) > minutes(PAYMENT_WINDOW_MINUTES)) {
      // Frees the connector (the payment is released unless it was paid meanwhile).
      await settleCheckout(d, rec);
      throw new CheckoutError(
        "expired",
        "This payment page has expired. Reload the page to start again. Nothing was charged.",
      );
    }
    return { requestId, url: rec.checkoutUrl };
  }
  if (rec.phase !== "creating")
    throw new CheckoutError("refused", closedMessage(rec));

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
      throw unconfirmed(e, "Pay and charge");
    }
    if (bill.hold_minor !== rec.holdMinor)
      console.error(
        `cpo-starter-kit: checkout bill hold ${bill.hold_minor} differs from the tariff's ${rec.holdMinor} ${id}`,
      );
    await record({ billId: bill.id, error: null });
  }

  let payment: Payment;
  try {
    payment = await d.ivora.createPayment(
      {
        bill_id: rec.billId!,
        return_surface: "driver",
        return_reference: rec.reference,
      },
      keyFor(id, "payment"),
    );
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    log("payment", e, id);
    if (definite(e)) throw await fail(refusal(e, operatorName));
    throw unconfirmed(e, "Pay and charge");
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
    phase: "open",
    error: null,
  });
  return { requestId, url };
}

// ---- Free sessions ----

/** The start a free session sends: the operator's free token, never a paid tariff. */
async function sendFreeStart(
  d: CheckoutDeps,
  rec: CheckoutRecord,
  token: string,
): Promise<Operation> {
  return d.ivora.sendCommand(
    rec.stationId,
    {
      action: "start",
      connector_id: rec.connectorId,
      token,
      token_type: "Central",
    },
    keyFor(rec.id, "start"),
  );
}

/** Charger answers that mean yes (as in the Live view). */
const ACCEPTED = new Set(["Accepted", "Scheduled"]);

/** A start the charger or Ivora refused (nothing will run). */
function startRefused(op: Operation): string | null {
  const status =
    typeof op.result?.charger_status === "string"
      ? op.result.charger_status
      : null;
  if (op.status === "rejected") return "Ivora refused the start.";
  if (op.status === "succeeded" && status && !ACCEPTED.has(status))
    return `The charger answered ${status.slice(0, 40)}.`;
  return null;
}

/**
 * "Start free session": only while the connector's tariff is free (checked again just
 * before the command, so a tariff that turned paid while the page was open never gets
 * a free start), only to an Available connector, with the operator's free charging
 * token. The connector is claimed like a paid checkout (one per connector), the start
 * carries key cpo-checkout-<id>-start, and an uncertain start stays open and stoppable.
 * The same tap within a minute repeats an unconfirmed start with the same key.
 */
export async function startFreeSession(
  d: CheckoutDeps,
  input: { code: string; requestId: string; source: string | null },
  defaultOperatorName: string,
): Promise<{ requestId: string }> {
  if (!UUID.test(input.requestId))
    throw new CheckoutError("invalid", "Reload the page and try again.");
  const requestId = input.requestId.toLowerCase();
  const first = await resolve(d, input.code, defaultOperatorName);
  if (!first.ok) throw first.error;
  if (first.r.kind !== "free") throw notFree();
  const { found, operatorName } = first.r;

  let rec = await d.store.getByRequest(found.operatorId, requestId);
  if (rec && (rec.kind !== "free" || rec.stickerCode !== found.code))
    throw new CheckoutError("invalid", "Reload the page and try again.");
  if (rec && rec.phase !== "creating") {
    if (
      rec.phase === "open" &&
      !rec.startOperationId &&
      ageOf(d, rec.createdAt) < 60_000
    ) {
      // Repeated below with the same key.
    } else if (rec.phase === "open") return { requestId };
    else throw new CheckoutError("refused", closedMessage(rec));
  }

  let token: string | null;
  try {
    token = await ensureFreeToken(
      { store: d.tokens, ivora: d.ivora },
      found.operatorId,
    );
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    log("free token", e);
    throw new CheckoutError(
      "unavailable",
      "Free charging can't be started right now. Try again in a minute.",
      e.code,
      e.requestId,
    );
  }
  if (!token)
    throw new CheckoutError(
      "free_not_ready",
      `Free charging is turned off here right now. Please contact ${operatorName}.`,
    );

  if (!rec) {
    await takeLimits(d, found, input.source);
    let station: Station;
    let txs: Transaction[];
    try {
      station = await d.ivora.getStation(found.stationId);
      txs = await d.ivora.listTransactions({
        station_id: found.stationId,
        limit: 20,
      });
    } catch (e) {
      if (!(e instanceof IvoraError)) throw e;
      log("check", e);
      throw new CheckoutError(
        "unavailable",
        "The charger can't be checked right now. Try again in a minute.",
        e.code,
        e.requestId,
      );
    }
    const state = connectorState(station, found.connectorId);
    if (state.blocked) throw blockedError(state.blocked, state.status);
    if (
      !STARTABLE.has(state.status ?? "") ||
      txs.some((t) => t.connector_id === found.connectorId && running(t))
    )
      throw new CheckoutError(
        "in_use",
        `This connector reports “${state.status ?? "unknown"}”. A free session starts only on an Available connector: if your car is plugged in, unplug it, tap “Start free session”, then plug in.`,
      );
    const id = await claimConnector(d, {
      operatorId: found.operatorId,
      requestId,
      kind: "free",
      stickerCode: found.code,
      stationId: found.stationId,
      connectorId: found.connectorId,
      tariffId: first.r.ivoraTariffId,
      holdMinor: 0,
      currency: first.r.def.currency,
    });
    rec = (await d.store.get(found.operatorId, id))!;
  }
  const id = rec.id;

  // The price again, right before the command: free, and still the same tariff.
  const again = await resolve(d, input.code, defaultOperatorName);
  if (
    !again.ok ||
    again.r.kind !== "free" ||
    again.r.ivoraTariffId !== rec.tariffId
  ) {
    await d.store.record(found.operatorId, id, {
      phase: "failed",
      error: notFree().message,
    });
    throw notFree();
  }

  let op: Operation;
  try {
    op = await sendFreeStart(d, rec, token);
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    log("free start", e, id);
    if (definite(e)) {
      const err = refusal(e, operatorName);
      await d.store.record(found.operatorId, id, {
        phase: "failed",
        error: `${e.code}: ${err.message}`,
      });
      throw err;
    }
    // It may have reached the charger: open (and stoppable) until a session shows or
    // the wait passes.
    await d.store.record(found.operatorId, id, {
      phase: "open",
      startRequested: true,
      error:
        "The charger didn't confirm the start yet. If charging begins, you can stop it here.",
    });
    throw new CheckoutError(
      "unconfirmed",
      "The charger didn't confirm the start yet. Tap “Start free session” again within a minute (it repeats the same start, never a second one), or watch “Your session” above.",
      e.code,
      e.requestId,
    );
  }
  const refused = startRefused(op);
  await d.store.record(found.operatorId, id, {
    phase: refused ? "failed" : "open",
    startOperationId: op.id,
    startRequested: true,
    error: refused ? `${refused} Nothing was started.` : null,
  });
  if (refused)
    throw new CheckoutError("refused", `${refused} Nothing was started.`);
  return { requestId };
}

// ---- Settlement ----

const GIVE_UP_MS = GIVE_UP_HOURS * 3_600_000;

/** Ivora's estimate has reached HOLD_STOP_PERCENT of the hold. */
export const nearHold = (estimatedMinor: number, holdMinor: number) =>
  estimatedMinor * 100 >= holdMinor * HOLD_STOP_PERCENT;

/** Where a paid session's transaction ID is, once known. */
const transactionOf = (bill: Bill, rec: CheckoutRecord) =>
  bill.usage?.transaction_id ?? bill.transaction_id ?? rec.transactionId;

/**
 * Stops the session (key cpo-checkout-<id>-stop, the same for the driver's Stop and
 * the hold stop, so one stop is sent). An uncertain answer is tried again next time
 * with the same key.
 */
async function sendStop(
  d: CheckoutDeps,
  rec: CheckoutRecord,
  transactionId: number,
): Promise<"sent" | "ended" | "uncertain"> {
  try {
    await d.ivora.sendCommand(
      rec.stationId,
      { action: "stop", transaction_id: transactionId },
      keyFor(rec.id, "stop"),
    );
    return "sent";
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    log("stop", e, rec.id);
    return definite(e) ? "ended" : "uncertain";
  }
}

/** Releases the hold (key cpo-checkout-<id>-release). Nothing was charged. */
async function release(
  d: CheckoutDeps,
  rec: CheckoutRecord,
  why: string,
): Promise<void> {
  const op = rec.operatorId;
  if (!rec.paymentId) {
    await d.store.record(op, rec.id, { phase: "released", error: why });
    return;
  }
  await d.store.record(op, rec.id, { phase: "releasing", error: why });
  let p: Payment;
  try {
    p = await d.ivora.releasePayment(rec.paymentId, keyFor(rec.id, "release"));
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    log("release", e, rec.id);
    // start_reserved: a dispatched start could still produce a session; try later.
    if (!definite(e) || e.code === "start_reserved") return;
    p = await d.ivora.getPayment(rec.paymentId);
  }
  await recordPayment(d, rec, p, why);
}

/** Records a payment that reached an end (released, or captured after all). */
async function recordPayment(
  d: CheckoutDeps,
  rec: CheckoutRecord,
  p: Payment,
  why: string,
) {
  const op = rec.operatorId;
  if (p.status === "canceled")
    await d.store.record(op, rec.id, {
      phase: rec.phase === "settling" ? "settled" : "released",
      capturedMinor: 0,
      error: why,
    });
  else if (p.status === "captured" || p.status.startsWith("refund"))
    await d.store.record(op, rec.id, {
      phase: "settled",
      capturedMinor: p.captured_minor ?? 0,
      error: null,
    });
  else if (ageOf(d, rec.createdAt) > GIVE_UP_MS)
    await d.store.record(op, rec.id, {
      phase: "attention",
      error: `The hold could not be settled automatically (payment ${p.status}). ${why}`,
    });
}

/**
 * The session ended: finalize the bill from its completed transaction (key
 * cpo-checkout-<id>-finalize; Ivora reads the usage itself), then capture exactly the
 * final amount (key cpo-checkout-<id>-capture). A zero bill, or one below Stripe's
 * 50-cent minimum, is released by the capture. A bill above the hold goes to the
 * operator (Ivora staff capture the hold; the rest is not charged). Uncertain answers
 * are repeated later with the same keys.
 */
async function finalizeAndCapture(
  d: CheckoutDeps,
  rec: CheckoutRecord,
  bill: Bill,
): Promise<void> {
  const op = rec.operatorId;
  const stale = ageOf(d, rec.createdAt) > GIVE_UP_MS;
  const attention = (error: string) =>
    d.store.record(op, rec.id, { phase: "attention", error });
  if (bill.status !== "final") {
    const tx = transactionOf(bill, rec);
    if (!tx) {
      await release(d, rec, "No charging took place. Your hold was released.");
      return;
    }
    await d.store.record(op, rec.id, { phase: "settling", transactionId: tx });
    rec = { ...rec, phase: "settling" };
    try {
      bill = await d.ivora.finalizeBill(
        rec.billId!,
        tx,
        keyFor(rec.id, "finalize"),
      );
    } catch (e) {
      if (!(e instanceof IvoraError)) throw e;
      log("finalize", e, rec.id);
      // The transaction may not be complete in the charging core yet: try later.
      if (stale)
        await attention(
          `The bill could not be finalized (${e.code}). Check it in Ivora.`,
        );
      return;
    }
  } else if (rec.phase !== "settling") {
    await d.store.record(op, rec.id, { phase: "settling" });
    rec = { ...rec, phase: "settling" };
  }
  const total = bill.total_minor;
  if (typeof total !== "number") return;
  await d.store.record(op, rec.id, { finalMinor: total });
  let p: Payment;
  try {
    p = await d.ivora.capturePayment(rec.paymentId!, keyFor(rec.id, "capture"));
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    log("capture", e, rec.id);
    if (e.code === "bill_exceeds_hold") {
      await attention(
        `The final bill (${formatMinor(total, rec.currency)}) is above the card hold (${formatMinor(rec.holdMinor, rec.currency)}). Ivora's staff capture the hold; the rest is not charged.`,
      );
      return;
    }
    if (!definite(e)) return;
    p = await d.ivora.getPayment(rec.paymentId!);
  }
  if (p.status === "captured" && (p.captured_minor ?? total) !== total)
    console.error(
      `cpo-starter-kit: checkout capture ${p.captured_minor} differs from the bill ${total} ${rec.id}`,
    );
  await recordPayment(
    d,
    rec,
    p,
    p.status === "canceled"
      ? "Nothing was charged: the final amount was below the card minimum. Your hold was released."
      : "",
  );
}

/**
 * A paid checkout: where its bill is, and what that means for the money. Returns the
 * bill it read, if any.
 */
async function settlePaid(
  d: CheckoutDeps,
  rec: CheckoutRecord,
): Promise<Bill | null> {
  const op = rec.operatorId;
  const age = ageOf(d, rec.createdAt);
  if (rec.phase === "creating") {
    // No payment page was handed out, so no hold exists: close it.
    if (age > minutes(CREATING_STALE_MINUTES))
      await d.store.record(op, rec.id, {
        phase: "released",
        error: "This checkout was not completed. Nothing was charged.",
      });
    return null;
  }
  if (!rec.billId || !rec.paymentId) return null;
  // A driver-return bill read also lets Ivora start an authorized payment once (the
  // documented driver-return rule).
  const bill = await d.ivora.getBill(rec.billId);
  await step(d, rec, bill);
  return bill;
}

async function step(d: CheckoutDeps, rec: CheckoutRecord, bill: Bill) {
  const op = rec.operatorId;
  const age = ageOf(d, rec.createdAt);
  if (bill.status === "final") return finalizeAndCapture(d, rec, bill);
  const tx = transactionOf(bill, rec);
  const usage = bill.usage;
  const progress = bill.progress ?? null;
  if (rec.phase === "settling") return finalizeAndCapture(d, rec, bill);
  const ongoing =
    progress === "starting" ||
    progress === "waiting_for_vehicle" ||
    progress === "charging";
  if (rec.phase === "releasing" && ongoing) {
    // A start ran after all: the session is settled as usual.
    await d.store.record(op, rec.id, { phase: "open" });
    rec = (await d.store.get(op, rec.id)) ?? rec;
  }
  if (tx && tx !== rec.transactionId)
    await d.store.record(op, rec.id, { transactionId: tx });
  switch (progress) {
    case "awaiting_payment":
      if (rec.phase === "releasing" || age > minutes(PAYMENT_WINDOW_MINUTES))
        await release(
          d,
          rec,
          "The payment was not completed in time. Nothing was charged.",
        );
      return;
    case "authorized":
      if (rec.phase === "releasing" || age > minutes(UNSTARTED_RELEASE_MINUTES))
        await release(
          d,
          rec,
          "Charging was not started. Your card hold was released; nothing was charged.",
        );
      return;
    case "starting":
    case "waiting_for_vehicle": {
      const dispatched =
        bill.start_operation?.created_at ?? rec.startRequestedAt;
      if (
        !tx &&
        dispatched &&
        now(d) - Date.parse(dispatched) > minutes(START_RESERVED_MINUTES)
      )
        await release(
          d,
          rec,
          "No car was plugged in in time. Your card hold was released; nothing was charged.",
        );
      return;
    }
    case "charging":
    case "start_failed":
      if (progress === "start_failed" && !tx) {
        // Ivora answers start_reserved until the start can't produce a session.
        await release(
          d,
          rec,
          "The charger did not start. Your card hold was released; nothing was charged.",
        );
        return;
      }
      if (usage && !usage.active) return finalizeAndCapture(d, rec, bill);
      if (
        rec.stopRequestedAt &&
        now(d) - Date.parse(rec.stopRequestedAt) > minutes(5)
      )
        // The charger ignored the stop: Ivora alerts its operators near the hold too.
        console.error(
          `cpo-starter-kit: checkout still charging after its hold stop ${rec.id}`,
        );
      if (
        tx &&
        !rec.stopRequestedAt &&
        typeof usage?.estimated_minor === "number" &&
        nearHold(usage.estimated_minor, bill.hold_minor)
      ) {
        const r = await sendStop(d, rec, tx);
        if (r === "uncertain") return;
        await d.store.record(op, rec.id, {
          stopRequested: true,
          error: `Charging was stopped at ${formatMinor(usage.estimated_minor, rec.currency)}, near your card hold of ${formatMinor(bill.hold_minor, rec.currency)}.`,
        });
        try {
          await d.ivora.recordHoldStop(
            rec.billId!,
            keyFor(rec.id, "hold-stop"),
          );
        } catch (e) {
          if (!(e instanceof IvoraError)) throw e;
          log("hold stop alert", e, rec.id);
        }
      }
      return;
    case "ended":
      return finalizeAndCapture(d, rec, bill);
    case "canceled":
      if (tx) return finalizeAndCapture(d, rec, bill);
      await d.store.record(op, rec.id, {
        phase: "released",
        error: "The payment was canceled or expired. Nothing was charged.",
      });
      return;
    default:
      return;
  }
}

/** The free session's transaction: this connector, the free token, since the claim. */
async function freeTransaction(
  d: CheckoutDeps,
  rec: CheckoutRecord,
): Promise<Transaction | null> {
  if (rec.transactionId) {
    try {
      return await d.ivora.getTransaction(rec.transactionId);
    } catch (e) {
      if (e instanceof IvoraError && e.status === 404) return null;
      throw e;
    }
  }
  const token = (await d.tokens.getFreeToken(rec.operatorId))?.idToken ?? null;
  const since = Date.parse(rec.createdAt) - 60_000;
  const txs = await d.ivora.listTransactions({
    station_id: rec.stationId,
    limit: 20,
  });
  return (
    txs.find(
      (t) =>
        t.connector_id === rec.connectorId &&
        isFreeSession(t, token) &&
        t.started_at !== null &&
        Date.parse(t.started_at) >= since,
    ) ?? null
  );
}

/** A free session: its transaction, if any (returned), and whether it ended. */
async function settleFree(
  d: CheckoutDeps,
  rec: CheckoutRecord,
): Promise<Transaction | null> {
  const op = rec.operatorId;
  const age = ageOf(d, rec.createdAt);
  if (rec.phase === "creating") {
    if (age > minutes(CREATING_STALE_MINUTES))
      await d.store.record(op, rec.id, {
        phase: "released",
        error: "This session did not start.",
      });
    return null;
  }
  const t = await freeTransaction(d, rec);
  if (t) {
    await d.store.record(op, rec.id, {
      transactionId: t.id,
      ...(running(t) ? {} : { phase: "settled", error: null }),
    });
    return t;
  }
  if (rec.startOperationId && rec.phase === "open") {
    const refused = startRefused(
      await d.ivora.getOperation(rec.startOperationId),
    );
    if (refused) {
      await d.store.record(op, rec.id, {
        phase: "released",
        error: `${refused} Nothing was started.`,
      });
      return null;
    }
  }
  if (rec.transactionId || age > minutes(FREE_START_WAIT_MINUTES))
    await d.store.record(op, rec.id, {
      phase: rec.transactionId ? "settled" : "released",
      error: rec.transactionId ? null : "No session started on the charger.",
    });
  return null;
}

/**
 * Brings one checkout up to date with Ivora: closes stale taps, releases unused holds
 * (an expired payment page, a start that never ran, a refused or failed start), stops
 * a session whose cost nears its hold, and finalizes and captures an ended one. Safe to
 * run at any time and more than once at a time: every write carries a key from the
 * checkout and its action, and phases only move forward. A failed read leaves it for
 * the next run.
 */
export async function settleCheckout(
  d: CheckoutDeps,
  rec: CheckoutRecord,
): Promise<{ bill: Bill | null; tx: Transaction | null }> {
  const read = { bill: null as Bill | null, tx: null as Transaction | null };
  if (!UNSETTLED.has(rec.phase)) return read;
  try {
    if (rec.kind === "free") read.tx = await settleFree(d, rec);
    else read.bill = await settlePaid(d, rec);
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    log("settle", e, rec.id);
  }
  await d.store.record(rec.operatorId, rec.id, { checked: true });
  return read;
}

/**
 * Settles the checkouts still in progress, least recently checked first: the server's
 * regular sweep (/api/cron/settle) or, with a station, a webhook's cue. Returns how
 * many were looked at.
 */
export async function settleOpenCheckouts(
  d: CheckoutDeps,
  o: { stationId?: number; limit?: number } = {},
): Promise<number> {
  const recs = await d.store.listUnsettled({
    stationId: o.stationId,
    limit: o.limit ?? 25,
  });
  for (const r of recs) {
    try {
      await settleCheckout(d, r);
    } catch (e) {
      console.error("cpo-starter-kit: settle failed:", {
        error: e instanceof Error ? e.name : "error",
        record: r.id,
      });
    }
  }
  return recs.length;
}

// ---- A driver back on the sticker's page ----

/** What each step of a paid session means for the driver. */
export const PROGRESS: Record<BillProgress, { label: string; detail: string }> =
  {
    awaiting_payment: {
      label: "Waiting for payment",
      detail: `The card hold is not confirmed yet. Finish paying on the payment page, or tap “Pay and charge” to open it again (within ${PAYMENT_WINDOW_MINUTES} minutes).`,
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
      detail: "This session has ended. Your final bill is being settled.",
    },
    start_failed: {
      label: "Didn't start",
      detail:
        "The charger did not confirm the start. If it doesn't start, your hold is released automatically.",
    },
    canceled: {
      label: "Canceled",
      detail:
        "The payment was canceled or expired before charging. Nothing was charged.",
    },
  };

export interface DriverSession {
  /** The tap's request ID (the browser's own). */
  requestId: string;
  kind: CheckoutKind;
  createdAt: string;
  label: string;
  detail: string;
  progress: BillProgress | null;
  energyKwh: string | null;
  estimate: string | null;
  /** The settled amounts (the demo receipt; live, Stripe emails the receipt). */
  receipt: { charged: string; released: string; hold: string } | null;
  /** A note, for example that the kit stopped charging near the hold. */
  note: string | null;
  canStart: boolean;
  canStop: boolean;
  /** Waiting for payment or running: the page refreshes. */
  live: boolean;
}

const kwh = (wh: number) => (Math.round(wh / 10) / 100).toFixed(2);

function sessionView(
  rec: CheckoutRecord,
  bill: Bill | null,
  tx: Transaction | null,
): DriverSession {
  const money = (m: number) => formatMinor(m, rec.currency);
  const base: DriverSession = {
    requestId: rec.requestId,
    kind: rec.kind,
    createdAt: rec.createdAt,
    label: "",
    detail: "",
    progress: null,
    energyKwh: null,
    estimate: null,
    receipt: null,
    note: null,
    canStart: false,
    canStop: false,
    live: false,
  };
  const energyWh = bill?.usage?.energy_wh ?? tx?.energy_wh ?? null;
  if (energyWh !== null && energyWh !== undefined)
    base.energyKwh = kwh(energyWh);
  switch (rec.phase) {
    case "failed":
      return {
        ...base,
        label: "Not started",
        detail: rec.error ?? "Nothing was charged.",
      };
    case "released":
      return {
        ...base,
        label: rec.kind === "free" ? "Didn't start" : "Not charged",
        detail:
          rec.kind === "free"
            ? (rec.error ?? "No session started.")
            : `${rec.error ?? "Nothing was charged."}${rec.paymentId ? ` Any card hold (${money(rec.holdMinor)}) was released.` : ""}`,
      };
    case "releasing":
      return {
        ...base,
        label: "Releasing your hold",
        detail: `${rec.error ?? "Nothing will be charged."} Your card hold of ${money(rec.holdMinor)} is being released.`,
      };
    case "settled":
      if (rec.kind === "free")
        return {
          ...base,
          label: "Finished",
          detail: "Your free session has ended. Nothing was charged.",
        };
      return {
        ...base,
        label: "Finished",
        detail:
          rec.capturedMinor === 0
            ? (rec.error ?? "Nothing was charged. Your hold was released.")
            : "Your card was charged for this session, and the rest of the hold was released.",
        receipt: {
          charged: money(rec.capturedMinor ?? 0),
          released: money(rec.holdMinor - (rec.capturedMinor ?? 0)),
          hold: money(rec.holdMinor),
        },
        note: rec.stopRequestedAt ? rec.error : null,
      };
    case "settling":
      return {
        ...base,
        label: "Finished",
        detail: "Your session has ended. Your final bill is being settled.",
        estimate: rec.finalMinor !== null ? money(rec.finalMinor) : null,
        note: rec.stopRequestedAt ? rec.error : null,
      };
    case "attention":
      return {
        ...base,
        label: "Finished",
        detail: `This session is being settled by the operator. You are never charged more than your card hold of ${money(rec.holdMinor)}.`,
      };
    case "creating":
      return {
        ...base,
        label: "Not confirmed",
        detail:
          rec.kind === "free"
            ? "The start was not confirmed. Tap “Start free session” to try again."
            : "The payment page was not opened. Tap “Pay and charge” to try again.",
      };
    case "open":
      break;
  }
  if (rec.kind === "free") {
    const active = tx ? running(tx) : false;
    return {
      ...base,
      label: active ? "Charging (free)" : "Starting (free)",
      detail: active
        ? "Your car is charging. This session is free."
        : (rec.error ??
          "The charger is ready. Plug in your car: charging starts when it is connected."),
      // An uncertain start stays stoppable (it may have reached the charger).
      canStop: active || !rec.startOperationId,
      live: true,
    };
  }
  const progress = bill?.progress ?? null;
  const p = progress
    ? PROGRESS[progress]
    : {
        label: "Waiting for payment",
        detail: PROGRESS.awaiting_payment.detail,
      };
  const usage = bill?.usage;
  const hold = bill?.hold_minor ?? rec.holdMinor;
  const charging = progress === "charging" && usage?.active === true;
  return {
    ...base,
    label: p.label,
    detail: p.detail,
    progress,
    estimate:
      typeof usage?.estimated_minor === "number"
        ? money(usage.estimated_minor)
        : null,
    note: rec.stopRequestedAt
      ? rec.error
      : charging
        ? `Charging stops by itself at about ${money(Math.floor((hold * HOLD_STOP_PERCENT) / 100))}, so your card hold of ${money(hold)} covers the session.`
        : null,
    canStart: progress === "authorized",
    canStop: charging,
    live: progress !== "canceled" && progress !== "start_failed",
  };
}

/** This browser's recent checkouts at this sticker (request IDs from its cookie). */
async function ownCheckouts(
  d: CheckoutDeps,
  operatorId: string,
  code: string,
  requestIds: string[],
): Promise<CheckoutRecord[]> {
  const out: CheckoutRecord[] = [];
  for (const id of requestIds.filter((x) => UUID.test(x)).slice(0, 3)) {
    const r = await d.store.getByRequest(operatorId, id);
    if (
      r &&
      r.stickerCode === code &&
      ageOf(d, r.createdAt) < DRIVER_SESSION_HOURS * 3_600_000
    )
      out.push(r);
  }
  return out;
}

/**
 * The returning driver's sessions at this sticker, newest first. Each read also
 * settles them (and reading a driver-return bill is what lets Ivora start the charger
 * once the hold is authorized: the documented driver-return rule).
 */
export async function driverSessions(
  d: CheckoutDeps,
  rawCode: string,
  requestIds: string[],
): Promise<DriverSession[]> {
  const code = rawCode.toUpperCase();
  if (!requestIds.length || !isStickerCode(code)) return [];
  const found = await d.chargers.resolveCode(code);
  if (!found) return [];
  const out: DriverSession[] = [];
  for (const first of await ownCheckouts(
    d,
    found.operatorId,
    code,
    requestIds,
  )) {
    // The bill or session settlement just read: no second read for the view.
    const { bill, tx } = await settleCheckout(d, first);
    const r = (await d.store.get(found.operatorId, first.id)) ?? first;
    out.push(sessionView(r, bill, tx));
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** This browser's own checkout at this sticker, or not_found. */
async function ownCheckout(
  d: CheckoutDeps,
  input: { code: string; requestId: string; requestIds: string[] },
) {
  const code = input.code.toUpperCase();
  const found = isStickerCode(code) ? await d.chargers.resolveCode(code) : null;
  if (!found || !input.requestIds.includes(input.requestId))
    throw new CheckoutError("not_found", "Reload the page and try again.");
  const [rec] = await ownCheckouts(d, found.operatorId, code, [
    input.requestId,
  ]);
  if (!rec)
    throw new CheckoutError("not_found", "Reload the page and try again.");
  return { found, rec };
}

/**
 * Starts a paid bill whose automatic start Ivora refused (`progress` authorized, for
 * example because the charger was offline when the driver came back). Only the browser
 * that made the checkout can ask (its request ID is in their cookie), and only to an
 * Available connector (as staff remote starts). The key is fixed per checkout, and
 * Ivora answers any later start of the bill with its one start operation, so the
 * charger is never started twice. A definite refusal releases the hold at once.
 */
export async function startPaidSession(
  d: CheckoutDeps,
  input: { code: string; requestId: string; requestIds: string[] },
  defaultOperatorName: string,
): Promise<void> {
  const { found, rec } = await ownCheckout(d, input);
  if (rec.kind !== "paid" || !rec.billId || rec.phase !== "open")
    throw new CheckoutError("not_found", "Reload the page and try again.");
  const operator = found.operatorName ?? defaultOperatorName;
  const releaseNow = async (why: string, e?: IvoraError) => {
    await release(
      d,
      rec,
      "The charger did not start. Your card hold was released; nothing was charged.",
    );
    return new CheckoutError(
      "refused",
      `${why} Your card hold was released, so nothing is charged. Reload the page to start again, or contact ${operator}.`,
      e?.code,
      e?.requestId,
    );
  };
  try {
    const bill = await d.ivora.getBill(rec.billId);
    if (bill.progress !== "authorized")
      throw new CheckoutError(
        "invalid",
        bill.progress === "awaiting_payment"
          ? "Your payment isn't confirmed yet. Finish paying first."
          : "This session has already started or ended. Reload the page.",
      );
    const state = connectorState(
      await d.ivora.getStation(rec.stationId),
      rec.connectorId,
    );
    if (state.blocked === "offline")
      throw await releaseNow("The charger is offline, so it can't start.");
    if (!STARTABLE.has(state.status ?? ""))
      throw new CheckoutError(
        "in_use",
        `The connector reports “${state.status ?? "unknown"}”. Charging starts only on an Available connector: if your car is plugged in, unplug it, tap “Start charging”, then plug in. Your card hold stays in place for now and is released if charging doesn't start.`,
      );
    await d.ivora.startBill(rec.billId, keyFor(rec.id, "start"));
  } catch (e) {
    if (e instanceof CheckoutError) throw e;
    if (!(e instanceof IvoraError)) throw e;
    log("start", e, rec.id);
    if (definite(e))
      throw await releaseNow(
        `The charger did not start (${refusal(e, operator).message.split(". ")[0]}).`,
        e,
      );
    throw new CheckoutError(
      "unconfirmed",
      "The charger didn't confirm the start yet. Wait a moment and reload the page before trying again.",
      e.code,
      e.requestId,
    );
  }
  await d.store.record(found.operatorId, rec.id, { startRequested: true });
}

/**
 * The driver's Stop, for their own running session (paid or free): one stop per
 * checkout (key cpo-checkout-<id>-stop), then the session is settled.
 */
export async function stopDriverSession(
  d: CheckoutDeps,
  input: { code: string; requestId: string; requestIds: string[] },
): Promise<void> {
  const { rec } = await ownCheckout(d, input);
  if (rec.phase !== "open")
    throw new CheckoutError("invalid", "This session is not running.");
  let tx: number | null = null;
  try {
    if (rec.kind === "paid" && rec.billId) {
      const bill = await d.ivora.getBill(rec.billId);
      if (bill.usage?.active) tx = transactionOf(bill, rec);
    } else {
      const t = await freeTransaction(d, rec);
      if (t && running(t)) tx = t.id;
    }
  } catch (e) {
    if (!(e instanceof IvoraError)) throw e;
    log("stop read", e, rec.id);
    throw new CheckoutError(
      "unavailable",
      "The session can't be read right now. Try again in a moment, or unplug your car.",
      e.code,
      e.requestId,
    );
  }
  if (!tx)
    throw new CheckoutError(
      "invalid",
      "No running session was found on the charger. If it is still charging, unplug your car.",
    );
  if ((await sendStop(d, rec, tx)) === "uncertain")
    throw new CheckoutError(
      "unconfirmed",
      "The charger didn't confirm the stop yet. Wait a moment and reload the page; you can also unplug your car.",
    );
  await settleCheckout(d, (await d.store.get(rec.operatorId, rec.id)) ?? rec);
}
