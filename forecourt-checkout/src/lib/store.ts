// Pay in store: the driver pays at the counter, like fuel at a convenience
// store. The store takes cash or card on its own POS; this app never touches
// that money. It only tells Ivora what happened, as settlement reports, so the
// operator's figures show "paid in store" next to card payments.
//
// Everything here is pure (no network, no clock, no crypto) so the live flow
// (src/lib/server/store.ts) and the demo (src/lib/demo-store.ts) share it.

import { assertCents, idleGraceCreditCents } from "./money";
import { parkingLines, quoteRows, type Quote, type QuoteRow } from "./tariff";

export const STORE_PREFIX = "forecourt:store:";
/** Ivora's descriptive processor name for these sessions. No adapter is called. */
export const STORE_PROCESSOR = "in-store";
/** Non-secret merchant reference sent with every in-store session. */
export const STORE_MERCHANT = "forecourt-store";

/** A cashier action the sale's state doesn't allow. Shown with its code. */
export class SaleError extends Error {
  readonly name = "SaleError";
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const MIN_PREPAID_CENTS = 100;
export const MAX_PREPAID_CENTS = 50_000;
export const MAX_LIMIT_WH = 500_000;

export type SaleMode = "prepay" | "postpay";
export type PaymentMethod = "cash" | "card";

/** What the cashier agreed with the driver. Fixed for the life of the sale. */
export type SaleTerms = {
  mode: SaleMode;
  /** Taken on the POS before charging (prepay only), in cents. */
  prepaidCents: number | null;
  /** Optional energy cap for prepay, in Wh. */
  limitWh: number | null;
};

// The sale ID carries its own terms, so no database is needed to remember
// them: `pre-<prepaid cents>-<limit Wh, 0 = none>-<nonce>` or `post-<nonce>`.
// It becomes Ivora's payment_reference, and application_reference is
// `forecourt:store:<sale ID>`. Only this server creates those sessions (with
// its API key), so the terms in the ID can be trusted.
const SALE_ID = /^(?:pre-(\d{1,5})-(\d{1,6})|post)-([a-z0-9]{12})$/;
const NONCE = /^[a-z0-9]{12}$/;

export function validateTerms(terms: SaleTerms): string | null {
  if (terms.mode === "postpay")
    return terms.prepaidCents === null && terms.limitWh === null
      ? null
      : "Pay-after sales have no prepaid amount or limit.";
  const p = terms.prepaidCents;
  if (p === null || !Number.isSafeInteger(p))
    return "Enter the prepaid amount.";
  if (p < MIN_PREPAID_CENTS || p > MAX_PREPAID_CENTS)
    return `The prepaid amount must be between $${MIN_PREPAID_CENTS / 100} and $${MAX_PREPAID_CENTS / 100}.`;
  const w = terms.limitWh;
  if (w !== null && (!Number.isSafeInteger(w) || w < 1000 || w > MAX_LIMIT_WH))
    return `The energy limit must be between 1 and ${MAX_LIMIT_WH / 1000} kWh.`;
  return null;
}

export function encodeSaleId(terms: SaleTerms, nonce: string): string {
  const problem = validateTerms(terms);
  if (problem) throw new Error(problem);
  if (!NONCE.test(nonce)) throw new Error("Sale nonce must be 12 of [a-z0-9].");
  return terms.mode === "prepay"
    ? `pre-${terms.prepaidCents}-${terms.limitWh ?? 0}-${nonce}`
    : `post-${nonce}`;
}

export function decodeSaleId(sale: string): SaleTerms | null {
  const m = SALE_ID.exec(sale);
  if (!m) return null;
  const terms: SaleTerms = m[1]
    ? {
        mode: "prepay",
        prepaidCents: Number(m[1]),
        limitWh: Number(m[2]) || null,
      }
    : { mode: "postpay", prepaidCents: null, limitWh: null };
  return validateTerms(terms) ? null : terms;
}

export const storeReference = (sale: string) => `${STORE_PREFIX}${sale}`;

export function saleFromReference(applicationReference: string) {
  if (!applicationReference.startsWith(STORE_PREFIX)) return null;
  const sale = applicationReference.slice(STORE_PREFIX.length);
  return decodeSaleId(sale) ? sale : null;
}

/** Every write for a sale uses a key from the sale ID and the action, so a retry never acts twice. */
export const saleKey = (sale: string, action: string) =>
  `forecourt:store:${sale}:${action}`;

/** "PUMP-3" -> "Charger 3": the number drivers tell the cashier, like a fuel pump. */
export function chargerLabel(code: string, connector: number, connectors = 1) {
  const n = /(\d+)$/.exec(code)?.[1];
  const base = n ? `Charger ${Number(n)}` : `Charger ${code}`;
  return connectors > 1 ? `${base}-${connector}` : base;
}

// --- Prepay: stop before the prepaid amount runs out --------------------------

/** How far ahead the money headroom looks: meter samples, webhook and charger latency. */
export const STOP_LOOKAHEAD_SECONDS = 60;
/** How far ahead a kWh sale's energy limit looks: one 30 s meter sample interval. */
export const ENERGY_LOOKAHEAD_SECONDS = 30;
export const MIN_HEADROOM_CENTS = 50;
/** At least 5% of the prepaid amount is kept back. */
export const MIN_HEADROOM_BPS = 500;

export type StopDecision = {
  stop: boolean;
  reason: "amount" | "energy" | null;
  /** Running cost at which charging is stopped, in cents. */
  stopAtCents: number;
  headroomCents: number;
};

/**
 * Ivora does not stop a session at an external amount, so the app does. It
 * keeps back the cost of the next minute at the recent power (energy at the
 * tariff's per-kWh price, plus the higher of the time and idle rates), with a
 * floor of 50 cents or 5% of the prepaid amount, whichever is more.
 *
 * A kWh sale (limitWh set) stops on energy: the next 30 seconds' energy at
 * the recent power, at least 1% of the limit. Its prepaid amount is the quote for
 * that energy, so money only acts as a safety cap there, keeping back just the
 * next minute's cost, without the 50 cent / 5% floor.
 * Prices are in hundredths of a cent, as priceBreakdown() returns them.
 */
export function prepayStop(input: {
  prepaidCents: number;
  limitWh: number | null;
  estimatedCents: number;
  energyWh: number;
  powerW: number | null;
  energyPerKwh: number;
  timePerHour: number;
  idlePerHour: number;
}): StopDecision {
  assertCents(input.prepaidCents, "prepaidCents");
  const L = BigInt(STOP_LOOKAHEAD_SECONDS);
  const power = BigInt(Math.max(0, Math.round(input.powerW ?? 0)));
  // W x s x (1/100 cent per kWh) / (3600 s/h x 1000 W/kW) = 1/100 cent
  const energyHundredths = ceilDiv(
    power * L * BigInt(input.energyPerKwh),
    3_600_000n,
  );
  const timeHundredths = ceilDiv(
    BigInt(Math.max(input.timePerHour, input.idlePerHour)) * L,
    3600n,
  );
  const projectedCents = Number(
    ceilDiv(energyHundredths + timeHundredths, 100n),
  );
  const byEnergy = input.limitWh !== null;
  const headroomCents = byEnergy
    ? Math.max(1, projectedCents)
    : Math.max(
        MIN_HEADROOM_CENTS,
        Math.ceil((input.prepaidCents * MIN_HEADROOM_BPS) / 10_000),
        projectedCents,
      );
  const stopAtCents = Math.max(0, input.prepaidCents - headroomCents);
  if (input.limitWh !== null) {
    const headroomWh = Math.max(
      Math.ceil(input.limitWh / 100),
      Number(ceilDiv(power * BigInt(ENERGY_LOOKAHEAD_SECONDS), 3600n)),
    );
    if (input.energyWh >= input.limitWh - headroomWh)
      return { stop: true, reason: "energy", stopAtCents, headroomCents };
  }
  if ((input.estimatedCents ?? 0) >= stopAtCents)
    return { stop: true, reason: "amount", stopAtCents, headroomCents };
  return { stop: false, reason: null, stopAtCents, headroomCents };
}

function ceilDiv(a: bigint, b: bigint) {
  return (a + b - 1n) / b;
}

// --- The bill and what is owed ----------------------------------------------

export type SaleBill = {
  rows: QuoteRow[];
  currency: string;
  billTotalCents: number;
  graceCreditCents: number;
  /** What the sale costs: the bill less the idle grace credit. */
  dueCents: number;
  idleSeconds: number;
  graceMinutes: number;
};

/** Same grace rule as card payments; no card minimum applies at the counter. */
export function saleBill(input: {
  bill: Quote;
  billTotalCents: number;
  idleSeconds: number;
  graceMinutes: number;
}): SaleBill {
  assertCents(input.billTotalCents, "billTotalCents");
  const graceCreditCents = idleGraceCreditCents({
    parkingLines: parkingLines(input.bill),
    idleSeconds: input.idleSeconds,
    graceSeconds: input.graceMinutes * 60,
  });
  return {
    rows: quoteRows(input.bill),
    currency: input.bill.currency,
    billTotalCents: input.billTotalCents,
    graceCreditCents,
    dueCents: Math.max(0, input.billTotalCents - graceCreditCents),
    idleSeconds: input.idleSeconds,
    graceMinutes: input.graceMinutes,
  };
}

/** A settlement report as Ivora stores it. Reports record facts; they never move money. */
export type SaleReport = {
  kind: "authorization" | "capture" | "refund" | "release";
  operation_reference: string;
  outcome: "pending" | "unknown" | "succeeded" | "failed";
  amount_minor: number;
  created_at?: string;
};

export type StorePayment = {
  step: "prepaid" | "paid" | "extra";
  method: PaymentMethod | null;
  posReference: string | null;
  amountCents: number;
};

export type SaleAmounts = {
  dueCents: number;
  prepaidCents: number;
  /** Prepay: the part of the cost the prepaid amount covers. */
  coveredCents: number;
  /** Prepay: prepaid − cost, for the cashier to hand back. */
  changeCents: number;
  changeGiven: boolean;
  /** Prepay: cost above the prepaid amount. Never collected automatically. */
  overrunCents: number;
  /** Recorded in Ivora as collected in store. */
  collectedCents: number;
  /** Still to collect at the counter. */
  outstandingCents: number;
  /** The automatic prepay capture report is in Ivora. */
  prepaidRecorded: boolean;
  payments: StorePayment[];
  /** When the cashier last recorded a payment or change, if known. */
  settledAt: string | null;
  status: "due" | "change" | "paid";
};

const POS_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
export const isPosReference = (v: string) => POS_REFERENCE.test(v);

/** Operation references: one stable ID per distinct financial operation. */
export const operationRef = {
  /** The amount the store took before the start (authorization). */
  prepaid: (sale: string) => sale,
  /** The part of it the session used: a distinct operation, so its own ID. */
  covered: (sale: string) => `${sale}:capture`,
  paid: (sale: string, method: PaymentMethod, pos: string | null) =>
    `${sale}:paid:${method}${pos ? `:${pos}` : ""}`,
  extra: (sale: string, method: PaymentMethod, pos: string | null) =>
    `${sale}:extra:${method}${pos ? `:${pos}` : ""}`,
  change: (sale: string) => `${sale}:change`,
};

function paymentOf(sale: string, r: SaleReport): StorePayment | null {
  if (r.kind !== "capture" || r.outcome !== "succeeded") return null;
  if (r.operation_reference === operationRef.covered(sale))
    return {
      step: "prepaid",
      method: null,
      posReference: null,
      amountCents: r.amount_minor,
    };
  const rest = r.operation_reference.startsWith(`${sale}:`)
    ? r.operation_reference.slice(sale.length + 1).split(":")
    : [];
  const [step, method, pos] = rest;
  if ((step !== "paid" && step !== "extra") || !method) return null;
  return {
    step,
    method: method === "card" ? "card" : "cash",
    posReference: pos ?? null,
    amountCents: r.amount_minor,
  };
}

/**
 * What the sale owes, from its terms, its cost and the reports already in
 * Ivora. A prepaid overrun is shown and stays outstanding until the cashier
 * marks it paid by hand; it is never charged or recorded as collected here.
 */
export function saleAmounts(
  sale: string,
  terms: SaleTerms,
  dueCents: number,
  reports: SaleReport[],
): SaleAmounts {
  assertCents(dueCents, "dueCents");
  const payments = reports
    .map((r) => paymentOf(sale, r))
    .filter((p): p is StorePayment => p !== null);
  const sum = (steps: StorePayment["step"][]) =>
    payments
      .filter((p) => steps.includes(p.step))
      .reduce((total, p) => total + p.amountCents, 0);
  const settledAt =
    reports
      .filter(
        (r) =>
          r.outcome === "succeeded" &&
          r.operation_reference.startsWith(`${sale}:`) &&
          r.operation_reference !== operationRef.covered(sale) &&
          r.created_at,
      )
      .map((r) => r.created_at!)
      .sort()
      .at(-1) ?? null;
  const changeGiven = reports.some(
    (r) =>
      r.kind === "release" &&
      r.outcome === "succeeded" &&
      r.operation_reference === operationRef.change(sale),
  );
  if (terms.mode === "prepay") {
    const prepaidCents = terms.prepaidCents ?? 0;
    const coveredCents = Math.min(dueCents, prepaidCents);
    const overrunCents = dueCents - coveredCents;
    const extra = sum(["extra"]);
    const outstandingCents = Math.max(0, overrunCents - extra);
    const changeCents = prepaidCents - coveredCents;
    return {
      dueCents,
      prepaidCents,
      coveredCents,
      changeCents,
      changeGiven,
      overrunCents,
      collectedCents: coveredCents + extra,
      outstandingCents,
      prepaidRecorded: coveredCents === 0 || sum(["prepaid"]) === coveredCents,
      payments,
      settledAt,
      status:
        outstandingCents > 0
          ? "due"
          : changeCents > 0 && !changeGiven
            ? "change"
            : "paid",
    };
  }
  const collectedCents = sum(["paid"]);
  const outstandingCents = Math.max(0, dueCents - collectedCents);
  return {
    dueCents,
    prepaidCents: 0,
    coveredCents: 0,
    changeCents: 0,
    changeGiven: false,
    overrunCents: 0,
    collectedCents,
    outstandingCents,
    prepaidRecorded: true,
    payments,
    settledAt,
    status: outstandingCents > 0 ? "due" : "paid",
  };
}

// --- The settlement report sequence -----------------------------------------

/** A report to send, with the idempotency key suffix for its step. */
export type PlannedReport = {
  step: "authorization" | "capture" | "paid" | "extra" | "change";
  kind: "authorization" | "capture" | "release";
  operation_reference: string;
  amount_minor: number;
};

/** Before the start: prepay records the amount taken on the POS. */
export function startReports(sale: string, terms: SaleTerms): PlannedReport[] {
  if (terms.mode !== "prepay" || !terms.prepaidCents) return [];
  return [
    {
      step: "authorization",
      kind: "authorization",
      operation_reference: operationRef.prepaid(sale),
      amount_minor: terms.prepaidCents,
    },
  ];
}

/** After the final bill: prepay records the part the prepaid amount covered. */
export function endReports(
  sale: string,
  terms: SaleTerms,
  amounts: SaleAmounts,
): PlannedReport[] {
  if (terms.mode !== "prepay" || amounts.prepaidRecorded) return [];
  return [
    {
      step: "capture",
      kind: "capture",
      operation_reference: operationRef.covered(sale),
      amount_minor: amounts.coveredCents,
    },
  ];
}

export type RuleResult =
  | { ok: true; report: PlannedReport | null }
  | { ok: false; code: string; message: string };

/**
 * The cashier took payment on the POS. The amount must be exactly what is
 * outstanding on the final bill. Repeating the same mark-paid is a no-op.
 */
export function paidReport(
  sale: string,
  terms: SaleTerms,
  amounts: SaleAmounts,
  input: {
    amountCents: number;
    method: PaymentMethod;
    posReference: string | null;
  },
): RuleResult {
  if (input.posReference !== null && !isPosReference(input.posReference))
    return {
      ok: false,
      code: "invalid_pos_reference",
      message: "POS references use letters, digits, dot, dash or underscore.",
    };
  const step = terms.mode === "prepay" ? "extra" : "paid";
  if (amounts.outstandingCents === 0) {
    const done = amounts.payments.find((p) => p.step === step);
    if (done && done.amountCents === input.amountCents)
      return { ok: true, report: null };
    // Never anything to collect, such as a prepaid sale with only change to hand back.
    if (!done)
      return {
        ok: false,
        code: "nothing_due",
        message:
          amounts.changeCents > 0
            ? "Nothing is due on this sale: hand back the change instead."
            : "Nothing is due on this sale.",
      };
    return {
      ok: false,
      code: "already_paid",
      message: "Nothing is outstanding on this sale.",
    };
  }
  if (input.amountCents !== amounts.outstandingCents)
    return {
      ok: false,
      code: "amount_mismatch",
      message: `The amount due on the final bill is ${amounts.outstandingCents} cents.`,
    };
  return {
    ok: true,
    report: {
      step,
      kind: "capture",
      operation_reference: operationRef[step](
        sale,
        input.method,
        input.posReference,
      ),
      amount_minor: input.amountCents,
    },
  };
}

/** The cashier handed back the unused prepaid amount: recorded as a release. */
export function changeReport(sale: string, amounts: SaleAmounts): RuleResult {
  if (amounts.changeCents === 0)
    return { ok: false, code: "no_change", message: "No change is owed." };
  if (amounts.changeGiven) return { ok: true, report: null };
  return {
    ok: true,
    report: {
      step: "change",
      kind: "release",
      operation_reference: operationRef.change(sale),
      amount_minor: 0,
    },
  };
}

// --- What the console and the driver see -------------------------------------

export type SalePhase =
  | "starting" // authorised, start sent to the charger
  | "charging"
  | "finished" // charging ended, car still plugged in
  | "settling" // transaction ended, bill being finalized
  | "done" // final bill: due, change or paid
  | "canceled" // never charged
  | "review"; // needs the site's attention

export type SaleView = {
  sale: string;
  demo: boolean;
  terms: SaleTerms;
  charger: { code: string; label: string; name: string; connector: number };
  phase: SalePhase;
  currency: string;
  energyWh: number;
  powerW: number | null;
  /** Running cost (Ivora's estimate), in cents. */
  runningCents: number | null;
  startedAt: string | null;
  endedAt: string | null;
  /** A stop has been sent: by the cashier or at the prepaid limit. */
  stopping: boolean;
  /**
   * A stop that didn't take: "failed" after every attempt was rejected,
   * "unconfirmed" when Ivora can't tell whether it reached the charger. Either
   * way the cashier must stop it at the charger.
   */
  stopProblem: StopProblem | null;
  limitReached: "amount" | "energy" | null;
  canStop: boolean;
  bill: SaleBill | null;
  amounts: SaleAmounts | null;
  /** Demo time runs faster. */
  speed: number;
  message: string | null;
  error: { code: string; message: string; requestId: string | null } | null;
};

export type StopProblem = "failed" | "unconfirmed";

export const STOP_PROBLEM_TEXT: Record<StopProblem, string> = {
  failed: "Stop failed: stop it at the charger.",
  unconfirmed:
    "Stop not confirmed: check the charger and stop it there if it is still charging.",
};

// --- Stop attempts ------------------------------------------------------------

/** Rejected stops are retried with a new key, at most this many attempts in all. */
export const MAX_STOP_ATTEMPTS = 3;

/** "stop", then "stop-2", "stop-3": one idempotency key per attempt. */
export const stopKey = (sale: string, attempt: number) =>
  saleKey(sale, attempt === 1 ? "stop" : `stop-${attempt}`);

// --- What the driver's screen gets --------------------------------------------

/**
 * The public "pay at the counter" screen gets only what the driver needs:
 * status, energy, time, and the amount due or change. No payments, methods or
 * POS references.
 */
export type DriverSale = {
  phase: SalePhase;
  currency: string;
  energyWh: number;
  powerW: number | null;
  runningCents: number | null;
  prepaidCents: number | null;
  startedAt: string | null;
  endedAt: string | null;
  message: string | null;
  amounts: {
    dueCents: number;
    outstandingCents: number;
    overrunCents: number;
    changeCents: number;
    changeGiven: boolean;
    status: SaleAmounts["status"];
  } | null;
};

export function driverSale(v: SaleView): DriverSale {
  const a = v.amounts;
  return {
    phase: v.phase,
    currency: v.currency,
    energyWh: v.energyWh,
    powerW: v.powerW,
    runningCents: v.runningCents,
    prepaidCents: v.terms.prepaidCents,
    startedAt: v.startedAt,
    endedAt: v.endedAt,
    // A failed stop is for the cashier; the driver sees "please see the cashier".
    message: v.stopProblem ? "Please see the cashier." : v.message,
    amounts: a && {
      dueCents: a.dueCents,
      outstandingCents: a.outstandingCents,
      overrunCents: a.overrunCents,
      changeCents: a.changeCents,
      changeGiven: a.changeGiven,
      status: a.status,
    },
  };
}

// --- The point-of-sale seam ---------------------------------------------------

/**
 * A sale finished and the counter has something to do: money to collect
 * (postpay, or a prepaid overrun) or change to hand back. Every field comes
 * from the sale's terms and final bill, never from payments recorded later,
 * so each delivery of the same event ID carries the same body. No card or
 * personal data.
 */
export type SaleDueEvent = {
  /** Stable per sale: `<sale ID>:due`. */
  id: string;
  type: "sale.due";
  sale: string;
  charger: { code: string; connector: number; label: string };
  mode: SaleMode;
  /** Postpay: the final bill less idle grace. Prepay: what it cost above the prepaid amount. */
  amountDueCents: number;
  /** Prepay: the unused prepaid amount to hand back. */
  changeDueCents: number;
  currency: string;
  energyWh: number;
  startedAt: string | null;
  endedAt: string | null;
};

/** The event for a sale that needs the counter, or null (still charging, or settled). */
export function saleDueEvent(v: SaleView): SaleDueEvent | null {
  const a = v.amounts;
  if (!a || (v.phase !== "done" && v.phase !== "canceled")) return null;
  if (a.status === "paid") return null;
  return {
    id: `${v.sale}:due`,
    type: "sale.due",
    sale: v.sale,
    charger: {
      code: v.charger.code,
      connector: v.charger.connector,
      label: v.charger.label,
    },
    mode: v.terms.mode,
    amountDueCents: v.terms.mode === "prepay" ? a.overrunCents : a.dueCents,
    changeDueCents: a.changeCents,
    currency: v.currency,
    energyWh: v.energyWh,
    startedAt: v.startedAt,
    endedAt: v.endedAt,
  };
}

export type TileState =
  | "available"
  | "plugged_in"
  | "starting"
  | "charging"
  | "done_unpaid"
  | "paid"
  | "card"
  | "offline"
  | "faulted";

export const TILE_LABELS: Record<TileState, string> = {
  available: "Available",
  plugged_in: "Plugged in",
  starting: "Starting",
  charging: "Charging",
  done_unpaid: "Done unpaid",
  paid: "Paid",
  card: "Paying by card",
  offline: "Offline",
  faulted: "Faulted",
};

export type Tile = {
  key: string;
  code: string;
  label: string;
  stationName: string;
  connector: number;
  connectorLabel: string;
  /** The charger's own connector status (OCPP). */
  status: string;
  online: boolean;
  state: TileState;
  sale: SaleView | null;
  /** Something the cashier must check, such as a session the console didn't start. */
  warning: string | null;
  canPrepay: boolean;
  canPostpay: boolean;
};

export const READY_STATUSES = new Set(["Available", "Preparing"]);
/** The driver has plugged in and the charger waits for authorisation. */
export const PLUGGED_STATUSES = new Set(["Preparing"]);
/** A car is drawing (or waiting to draw) power inside a transaction. */
export const IN_USE_STATUSES = new Set([
  "Charging",
  "SuspendedEV",
  "SuspendedEVSE",
]);
const UNPAID = new Set<SalePhase>([
  "starting",
  "charging",
  "finished",
  "settling",
  "review",
]);

export const OUTSIDE_WARNING =
  "Charging without a console sale. Check that this charger requires authorisation (no free vend or auto-start).";

/** One tile's state, from the charger and its latest sale. */
export function tileState(input: {
  online: boolean;
  status: string;
  sale: SaleView | null;
  cardOpen: boolean;
  foreignOpen: boolean;
}): Pick<Tile, "state" | "warning" | "canPrepay" | "canPostpay"> {
  const { sale, cardOpen, foreignOpen } = input;
  const active = sale !== null && UNPAID.has(sale.phase);
  const free = input.online && !active && !cardOpen && !foreignOpen;
  const outside =
    foreignOpen || (!active && !cardOpen && IN_USE_STATUSES.has(input.status));
  let state: TileState;
  if (active)
    state =
      sale.phase === "starting"
        ? "starting"
        : sale.phase === "review"
          ? "done_unpaid"
          : "charging";
  else if (
    (sale?.phase === "done" || sale?.phase === "canceled") &&
    sale.amounts &&
    sale.amounts.status !== "paid"
  )
    state = "done_unpaid";
  else if (cardOpen) state = "card";
  else if (!input.online) state = "offline";
  else if (input.status === "Faulted") state = "faulted";
  else if (outside) state = "charging";
  else if (sale?.phase === "done") state = "paid";
  else if (PLUGGED_STATUSES.has(input.status)) state = "plugged_in";
  else if (input.status === "Available") state = "available";
  else state = "offline";
  return {
    state,
    warning: outside ? OUTSIDE_WARNING : null,
    canPrepay: free && READY_STATUSES.has(input.status),
    canPostpay: free && PLUGGED_STATUSES.has(input.status),
  };
}

/** "20", "20.5" or "$20.55" typed by the cashier -> cents, without floats. */
export function parseDollars(text: string): number | null {
  const m = /^\$?\s*(\d{1,5})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** "12" or "12.5" kWh typed by the cashier -> Wh, without floats. */
export function parseKwh(text: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0"));
}
