// Point-of-sale integration: what a convenience-store POS sends and receives.
// No specific vendor. Outbound, the app POSTs a signed `session_due` webhook;
// inbound, the POS calls /api/pos/mark-paid and /api/pos/sessions with a
// bearer token. Everything here is pure so the live flow and the demo's
// simulated POS build exactly the same messages.
//
// Nothing here carries card data or personal data: only sale, charger,
// energy, time and money.

import type { SaleDueEvent, SaleView } from "./store";
import { whToKwhText } from "./units";
import { signPayload, verifySignature } from "./webhook";

export const POS_EVENT_TYPE = "session_due";
/** `t=<unix>,v1=<hex>`, HMAC-SHA256 of `<t>.<raw body>` with POS_WEBHOOK_SECRET. */
export const POS_SIGNATURE_HEADER = "Forecourt-Signature";
/** The event ID again, so a POS can de-duplicate before parsing. */
export const POS_EVENT_HEADER = "Forecourt-Event-Id";

/** The `session_due` webhook body. */
export type SessionDuePayload = {
  /** Stable per sale: every redelivery carries the same ID and body. */
  id: string;
  type: typeof POS_EVENT_TYPE;
  sale_id: string;
  charger_code: string;
  connector: number;
  charger_label: string;
  mode: "prepay" | "postpay";
  /** To collect at the counter, in minor units (cents). 0 when only change is owed. */
  amount_due_minor: number;
  /** Prepay: unused prepaid amount to hand back, in minor units. */
  change_due_minor: number;
  currency: string;
  /** Decimal string with 3 places, from the charger's integer Wh. */
  energy_kwh: string;
  /** ISO 8601 in UTC. */
  started_at: string | null;
  ended_at: string | null;
};

const utc = (iso: string | null) =>
  iso === null ? null : new Date(iso).toISOString();

export function sessionDuePayload(e: SaleDueEvent): SessionDuePayload {
  return {
    id: e.id,
    type: POS_EVENT_TYPE,
    sale_id: e.sale,
    charger_code: e.charger.code,
    connector: e.charger.connector,
    charger_label: e.charger.label,
    mode: e.mode,
    amount_due_minor: e.amountDueCents,
    change_due_minor: e.changeDueCents,
    currency: e.currency,
    energy_kwh: whToKwhText(e.energyWh, 3),
    started_at: utc(e.startedAt),
    ended_at: utc(e.endedAt),
  };
}

/** The exact bytes sent. Built once per event, so every attempt signs the same body. */
export const sessionDueBody = (e: SaleDueEvent) =>
  JSON.stringify(sessionDuePayload(e));

export const signPosBody = signPayload;
export const verifyPosSignature = verifySignature;

/** Statuses for GET /api/pos/sessions. */
export const POS_STATUSES = ["due", "charging", "paid"] as const;
export type PosStatus = (typeof POS_STATUSES)[number];

const CHARGING = new Set(["starting", "charging", "finished", "settling"]);

/**
 * due: finished with money to collect. charging: authorised, charging or
 * waiting for its bill. paid: finished with nothing left to collect (change
 * may still be owed). Sales that need the site's review are in none.
 */
export function posStatusOf(v: SaleView): PosStatus | null {
  if (CHARGING.has(v.phase)) return "charging";
  if ((v.phase === "done" || v.phase === "canceled") && v.amounts)
    return v.amounts.outstandingCents > 0 ? "due" : "paid";
  return null;
}

export type PosSale = {
  sale_id: string;
  status: PosStatus;
  charger_code: string;
  connector: number;
  charger_label: string;
  mode: "prepay" | "postpay";
  prepaid_minor: number | null;
  /** Still to collect now, in minor units. */
  amount_due_minor: number;
  change_due_minor: number;
  change_given: boolean;
  /** Charging: Ivora's running estimate. Finished: the bill less idle grace. */
  cost_minor: number | null;
  currency: string;
  energy_kwh: string;
  started_at: string | null;
  ended_at: string | null;
  payments: {
    method: "cash" | "card";
    pos_reference: string | null;
    amount_minor: number;
  }[];
};

export function posSale(v: SaleView, status: PosStatus): PosSale {
  const a = v.amounts;
  return {
    sale_id: v.sale,
    status,
    charger_code: v.charger.code,
    connector: v.charger.connector,
    charger_label: v.charger.label,
    mode: v.terms.mode,
    prepaid_minor: v.terms.prepaidCents,
    amount_due_minor: a?.outstandingCents ?? 0,
    change_due_minor: a && !a.changeGiven ? a.changeCents : 0,
    change_given: a?.changeGiven ?? false,
    cost_minor: a ? a.dueCents : v.runningCents,
    currency: v.currency,
    energy_kwh: whToKwhText(v.energyWh, 3),
    started_at: utc(v.startedAt),
    ended_at: utc(v.endedAt),
    payments: (a?.payments ?? [])
      .filter((p) => p.step !== "prepaid" && p.method !== null)
      .map((p) => ({
        method: p.method!,
        pos_reference: p.posReference,
        amount_minor: p.amountCents,
      })),
  };
}

/** What POST /api/pos/mark-paid answers; the same for every repeat of the same request. */
export type PosPaidResult = {
  sale_id: string;
  status: "paid";
  amount_minor: number;
  method: "cash" | "card";
  pos_reference: string | null;
  currency: string;
};
