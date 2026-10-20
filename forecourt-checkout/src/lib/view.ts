import type { IdleTiming } from "./idle";
import { idleGraceCreditCents, settle, type Settlement } from "./money";
import { parkingLines, quoteRows, type Quote, type QuoteRow } from "./tariff";

export type Phase =
  | "payment" // checkout open, card not authorized yet
  | "starting" // hold authorized, start sent to the charger
  | "charging"
  | "finished" // charging ended, car still plugged in: idle countdown
  | "settling" // transaction ended, bill being finalized and captured
  | "completed" // receipt
  | "canceled" // never charged; hold released
  | "review"; // needs the site's attention

export type Receipt = {
  rows: QuoteRow[];
  currency: string;
  energyWh: number;
  startedAt: string | null;
  endedAt: string | null;
  idleSeconds: number;
  graceMinutes: number;
  settlement: Settlement;
};

export type SessionView = {
  id: string;
  demo: boolean;
  phase: Phase;
  charger: { code: string; name: string; connector: number };
  currency: string;
  holdCents: number;
  checkoutUrl: string | null;
  energyWh: number;
  powerW: number | null;
  /** Running cost so far, in cents (Ivora's estimate in live mode). */
  runningCents: number | null;
  startedAt: string | null;
  endedAt: string | null;
  idle:
    (IdleTiming & { idleCentsPerHour: number; graceMinutes: number }) | null;
  /** Demo time runs faster; shown so the countdown makes sense. */
  speed: number;
  canStop: boolean;
  receipt: Receipt | null;
  message: string | null;
  error: { code: string; message: string; requestId: string | null } | null;
};

/** Final receipt from Ivora's bill breakdown: grace credit, then capture or release. */
export function buildReceipt(input: {
  bill: Quote;
  billTotalCents: number;
  holdCents: number;
  idleSeconds: number;
  graceMinutes: number;
  applicationFeeBps: number;
  chargeApplicationFee: boolean;
  energyWh: number;
  startedAt: string | null;
  endedAt: string | null;
}): Receipt {
  const graceCreditCents = idleGraceCreditCents({
    parkingLines: parkingLines(input.bill),
    idleSeconds: input.idleSeconds,
    graceSeconds: input.graceMinutes * 60,
  });
  return {
    rows: quoteRows(input.bill),
    currency: input.bill.currency,
    energyWh: input.energyWh,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    idleSeconds: input.idleSeconds,
    graceMinutes: input.graceMinutes,
    settlement: settle({
      holdCents: input.holdCents,
      billTotalCents: input.billTotalCents,
      graceCreditCents,
      applicationFeeBps: input.applicationFeeBps,
      chargeApplicationFee: input.chargeApplicationFee,
    }),
  };
}

/** What the driver's browser may see: the deployer's fee stays server-side. */
export function publicView(view: SessionView): SessionView {
  if (!view.receipt) return view;
  return {
    ...view,
    receipt: {
      ...view.receipt,
      settlement: { ...view.receipt.settlement, applicationFeeCents: 0 },
    },
  };
}
