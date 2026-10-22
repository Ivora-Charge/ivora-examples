import "server-only";
import type { Command } from "@/lib/commands/store";
import { locationAppId } from "@/lib/locations/search";
import type { LocationStore } from "@/lib/locations/store";
import type { Cdr } from "@/lib/ocpi/session-objects";
import { cdrAmount } from "@/lib/payments/money";
import type { PaymentDeps } from "@/lib/payments/registry";
import { INCREMENT_DECLINED_REASON } from "@/lib/payments/settle";
import type { Payment } from "@/lib/payments/store";
import { isDemo } from "@/lib/server/demo";
import type {
  SessionStore,
  StoredCdr,
  StoredSession,
} from "@/lib/sessions/store";

/**
 * What the driver app shows of a charge: the start (a START_SESSION command), its
 * session as the CPO reports it, its payment and, once the CPO sent it, the receipt
 * from its CDR. Amounts are in minor units of `currency`; the app never computes what
 * was charged, it shows the payment's own figures.
 */

/**
 * Why we stopped a session, as a code the app turns into its own words:
 * `hold_increment_declined` (the card did not allow a higher hold; never a charger
 * fault), `other`, or null when we did not stop it.
 */
export type StopCode = "hold_increment_declined" | "other" | null;

export const stopCodeOf = (reason: string | null | undefined): StopCode =>
  !reason
    ? null
    : reason === INCREMENT_DECLINED_REASON
      ? "hold_increment_declined"
      : "other";

/** The CPO session a start is linked to: the one the Sessions module linked to it. */
export async function sessionOfStart(
  c: Command,
  sessions: SessionStore,
): Promise<StoredSession | null> {
  if (c.type !== "START_SESSION" || !c.sessionId) return null;
  const found = await sessions.findSessions(c.peerId, c.sessionId);
  return found.find((s) => s.commandId === c.id) ?? null;
}

export type SessionView = {
  /** Ours: the stored session's ID. */
  id: string;
  status: string;
  /** True while it charges (or is about to): show the live screen and the stop. */
  open: boolean;
  kwh: number;
  startedAt: string;
  endedAt: string | null;
  currency: string;
  /** The CPO's running cost, in minor units, when it sends one. */
  cost: { amount: number; vatIncluded: boolean } | null;
  stopCode: StopCode;
};

export function sessionView(s: StoredSession): SessionView {
  const open =
    ["ACTIVE", "PENDING", "RESERVATION"].includes(s.session.status) &&
    !s.completedAt;
  const total = s.session.total_cost;
  const cost = total ? cdrAmount(total, s.session.currency) : null;
  return {
    id: s.id,
    status: s.session.status,
    open,
    kwh: s.session.kwh,
    startedAt: s.session.start_date_time,
    endedAt: s.session.end_date_time ?? (open ? null : s.completedAt),
    currency: s.session.currency,
    cost: cost && { amount: cost.minor, vatIncluded: cost.vatKnown },
    stopCode: stopCodeOf(s.stopReason),
  };
}

export type PlaceView = {
  /** The app's location ID: open the charger page with it. */
  id: string;
  name: string;
  address: string;
  city: string;
};

/** The start's location, as the app names it; null when the CPO no longer lists it. */
export async function placeOf(
  c: Command,
  locations: LocationStore,
  cache = new Map<string, PlaceView | null>(),
): Promise<PlaceView | null> {
  if (!c.locationId) return null;
  const key = {
    peerId: c.peerId,
    countryCode: c.toCountryCode,
    partyId: c.toPartyId,
    id: c.locationId,
  };
  const id = locationAppId(key);
  if (cache.has(id)) return cache.get(id)!;
  const l = (await locations.getLocation(key))?.location;
  const place = l
    ? { id, name: l.name ?? l.address, address: l.address, city: l.city }
    : null;
  cache.set(id, place);
  return place;
}

/** The CDR a start's payment settles from: its first one that is not a credit CDR. */
export async function cdrOfStart(
  c: Command,
  sessions: SessionStore,
): Promise<StoredCdr | null> {
  return (
    (await sessions.findCdrsByCommand(c.id)).find((x) => !x.cdr.credit) ?? null
  );
}

export type ReceiptView = {
  chargeId: string;
  paymentId: string;
  cdrId: string;
  place: {
    name: string | null;
    address: string;
    city: string;
    evseId: string;
    connector: string;
    powerType: string;
  };
  startedAt: string;
  endedAt: string;
  kwh: number;
  /** Hours, as the CDR says. */
  hours: number;
  currency: string;
  /** The CPO's total for the session, in minor units, as the CDR says. */
  sessionCost: { amount: number; vatIncluded: boolean };
  /** What the payment did: held, captured (charged), refunded. Minor units. */
  held: number;
  charged: number;
  refunded: number;
  paymentStatus: Payment["status"];
  /** The session cost more than was held: only the hold was charged. */
  shortfall: number | null;
  underReview: boolean;
  stopReason: string | null;
  stopCode: StopCode;
  demo: boolean;
};

/** The receipt of a settled start, from its CDR and its payment's own figures. */
export function receiptView(
  c: Command,
  p: Payment,
  cdr: Cdr,
  storedCdrId: string,
): ReceiptView {
  const total = cdrAmount(cdr.total_cost, cdr.currency);
  return {
    chargeId: c.id,
    paymentId: p.id,
    cdrId: storedCdrId,
    place: {
      name: cdr.cdr_location.name ?? null,
      address: cdr.cdr_location.address,
      city: cdr.cdr_location.city,
      evseId: cdr.cdr_location.evse_id,
      connector: cdr.cdr_location.connector_standard,
      powerType: cdr.cdr_location.connector_power_type,
    },
    startedAt: cdr.start_date_time,
    endedAt: cdr.end_date_time,
    kwh: cdr.total_energy,
    hours: cdr.total_time,
    currency: cdr.currency,
    sessionCost: { amount: total.minor, vatIncluded: total.vatKnown },
    held: p.authorizedAmount,
    charged: p.capturedAmount,
    refunded: p.refundedAmount,
    paymentStatus: p.status,
    shortfall: p.shortfallAmount,
    underReview: p.review !== null && !p.reviewedAt,
    stopReason: p.stopReason,
    stopCode: stopCodeOf(p.stopReason),
    demo: isDemo(),
  };
}

export type HistoryItem = {
  chargeId: string;
  createdAt: string;
  /** The start's command status: succeeded, failed, hold_failed, ... */
  status: Command["status"];
  place: PlaceView | null;
  evseUid: string | null;
  session: SessionView | null;
  payment: {
    status: Payment["status"];
    currency: string;
    held: number;
    charged: number;
    refunded: number;
  };
  /** A receipt is ready (the CDR came and the payment settled from it). */
  receipt: boolean;
  stopCode: StopCode;
};

const SETTLED: readonly Payment["status"][] = ["captured", "released"];

/** The driver's charges with a payment, newest first: history and receipts. */
export async function history(
  driverRef: string,
  deps: Pick<PaymentDeps, "payments" | "commands" | "sessions" | "locations">,
  limit = 50,
): Promise<HistoryItem[]> {
  const places = new Map<string, PlaceView | null>();
  const out: HistoryItem[] = [];
  for (const p of await deps.payments.listByDriver(driverRef, limit)) {
    const c = await deps.commands.get(p.commandId);
    if (!c || c.driverRef !== driverRef || c.type !== "START_SESSION") continue;
    const s = await sessionOfStart(c, deps.sessions);
    out.push({
      chargeId: c.id,
      createdAt: c.createdAt,
      status: c.status,
      place: await placeOf(c, deps.locations, places),
      evseUid: c.evseUid,
      session: s && sessionView(s),
      payment: {
        status: p.status,
        currency: p.currency,
        held: p.authorizedAmount,
        charged: p.capturedAmount,
        refunded: p.refundedAmount,
      },
      receipt: p.cdrId !== null && SETTLED.includes(p.status),
      stopCode: stopCodeOf(p.stopReason ?? s?.stopReason),
    });
  }
  return out;
}

/**
 * The driver's charge in progress, if any: a start still open, or one that started and
 * whose session has not ended. Null otherwise.
 */
export async function activeCharge(
  driverRef: string,
  deps: Pick<PaymentDeps, "payments" | "commands" | "sessions">,
  now = Date.now(),
): Promise<Command | null> {
  for (const p of await deps.payments.listByDriver(driverRef, 10)) {
    if (p.status !== "pending" && p.status !== "held") continue;
    const c = await deps.commands.get(p.commandId);
    if (!c || c.driverRef !== driverRef || c.type !== "START_SESSION") continue;
    if (["claimed", "sending", "accepted"].includes(c.status)) return c;
    if (c.status !== "succeeded") continue;
    const s = await sessionOfStart(c, deps.sessions);
    if (s) {
      if (sessionView(s).open) return c;
      continue;
    }
    // Started, and the CPO has not reported the session yet: for a while only.
    if (now - Date.parse(c.finishedAt ?? c.createdAt) < NO_SESSION_WAIT_MS)
      return c;
  }
  return null;
}

/** How long a start the charger accepted counts as in progress without a session. */
export const NO_SESSION_WAIT_MS = 30 * 60_000;
