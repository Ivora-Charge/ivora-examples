"use server";

import {
  e4ToDecimal,
  minorToDecimal,
  mismatchesOf,
  reconcileWithPayments,
  reconciliationCsv,
  type ReconciledDay,
  type ReconciledTotal,
} from "@/lib/admin/reconciliation";
import { DEMO_PEER_ID } from "@/lib/locations/registry";
import { peerStore } from "@/lib/ocpi/registry";
import { paymentStore } from "@/lib/payments/registry";
import { asAdmin as gate, field } from "@/lib/server/admin-action";
import { sessionStore } from "@/lib/sessions/registry";
import { ReconciliationError } from "@/lib/sessions/reconcile";

/** One line of the reconciliation, ready to show: plain decimals, no E4 or minor units. */
export type ReconLine = {
  peer: string;
  /** Null on a total line. */
  day: string | null;
  currency: string;
  sessions: number;
  sessionsOpen: number;
  sessionsCompleted: number;
  sessionKwh: string;
  cdrs: number;
  creditCdrs: number;
  cdrKwh: string;
  cdrCostInclVat: string | null;
  cdrCostExclVat: string;
  cdrsPaid: number;
  captured: string;
  refunded: string;
  net: string;
  mismatches: number;
  /** What does not match, with the IDs to look at. */
  problems: { what: string; count: number; ids: string[] }[];
};

/** A payment flagged for a person (part 7), as the reconciliation shows it. */
export type FlaggedPayment = {
  id: string;
  commandId: string;
  review: string;
  status: string;
  captured: string;
  shortfall: string | null;
  createdAt: string;
};

export type ReconState = {
  ok?: boolean;
  message?: string;
  code?: string;
  nextStep?: string;
  lines?: ReconLine[];
  totals?: ReconLine[];
  flagged?: FlaggedPayment[];
  csv?: string;
  filename?: string;
};

const UUID = /^[0-9a-f-]{36}$/i;

function line(
  r: ReconciledDay | ReconciledTotal,
  day: string | null,
  labels: Map<string, string>,
): ReconLine {
  const money = (minor: number) => minorToDecimal(minor, r.currency);
  const ids = (x: object, k: string) =>
    k in x ? ((x as Record<string, string[]>)[k] ?? []) : [];
  const problems = [
    [
      "Completed sessions without a CDR",
      r.sessionsWithoutCdr,
      "sessionsWithoutCdrIds",
    ],
    [
      "CDRs naming no session we hold",
      r.cdrsWithoutSession,
      "cdrsWithoutSessionIds",
    ],
    [
      "CDRs of a token we did not issue",
      r.cdrsUnknownToken,
      "cdrsUnknownTokenIds",
    ],
    [
      "CDRs in another currency than their session",
      r.cdrsCurrencyMismatch,
      "cdrsCurrencyMismatchIds",
    ],
    ["CDRs of our drivers with no payment", r.cdrsUnpaid, "cdrsUnpaidIds"],
    [
      "Payments whose capture is not the CDR total",
      r.amountMismatches,
      "amountMismatchIds",
    ],
  ] as const;
  return {
    peer: labels.get(r.peerId) ?? r.peerId,
    day,
    currency: r.currency,
    sessions: r.sessions,
    sessionsOpen: r.sessionsOpen,
    sessionsCompleted: r.sessionsCompleted,
    sessionKwh: e4ToDecimal(r.sessionKwhE4),
    cdrs: r.cdrs,
    creditCdrs: r.creditCdrs,
    cdrKwh: e4ToDecimal(r.cdrEnergyE4),
    cdrCostInclVat:
      r.cdrCostInclVatE4 === null ? null : e4ToDecimal(r.cdrCostInclVatE4),
    cdrCostExclVat: e4ToDecimal(r.cdrCostExclVatE4),
    cdrsPaid: r.cdrsPaid,
    captured: money(r.capturedAmount),
    refunded: money(r.refundedAmount),
    net: money(r.capturedAmount - r.refundedAmount),
    mismatches: mismatchesOf(r),
    problems: problems
      .filter(([, count]) => count > 0)
      .map(([what, count, k]) => ({ what, count, ids: ids(r, k) })),
  };
}

/**
 * Sessions vs CDRs vs captured amounts, per peer and UTC day, with the mismatches, the
 * payments flagged for review, and the CSV of the days.
 */
export async function reconcileAction(
  _prev: ReconState,
  form: FormData,
): Promise<ReconState> {
  return gate(
    form,
    async (): Promise<ReconState> => {
      const peerId = field(form, "peerId").trim().toLowerCase();
      if (peerId && !UUID.test(peerId) && peerId !== DEMO_PEER_ID)
        return { ok: false, message: "Peer ID must be a UUID." };
      const from = field(form, "from").trim();
      const to = field(form, "to").trim();
      const payments = paymentStore();
      const report = await reconcileWithPayments(
        { from, to, peerId: peerId || undefined },
        { sessions: sessionStore(), payments },
      );
      const labels = new Map<string, string>([
        [DEMO_PEER_ID, "Mock CPO (demo)"],
        ...(await peerStore().listPeers()).map(
          (p) => [p.id, p.label] as [string, string],
        ),
      ]);
      const flagged = (await payments.listReview(100)).map((p) => ({
        id: p.id,
        commandId: p.commandId,
        review: p.review ?? "",
        status: p.status,
        captured: `${minorToDecimal(p.capturedAmount, p.currency)} ${p.currency}`,
        shortfall:
          p.shortfallAmount === null
            ? null
            : `${minorToDecimal(p.shortfallAmount, p.currency)} ${p.currency}`,
        createdAt: p.createdAt,
      }));
      const totals = report.totals.map((t) => line(t, null, labels));
      const mismatches = totals.reduce((n, t) => n + t.mismatches, 0);
      return {
        ok: true,
        message: report.days.length
          ? `${report.from} to ${report.to}: ${mismatches ? `${mismatches} mismatch(es) to look at` : "everything matches"}${flagged.length ? `; ${flagged.length} payment(s) flagged for review` : ""}.`
          : `No sessions or CDRs from ${report.from} to ${report.to}.`,
        lines: report.days.map((d) => line(d, d.day, labels)),
        totals,
        flagged,
        csv: reconciliationCsv(report, labels),
        filename: `reconciliation_${peerId || "all"}_${report.from}_${report.to}.csv`,
      };
    },
    {
      shown: (e) => e instanceof ReconciliationError,
      fallback: "Could not reconcile. Try again, or a shorter range.",
      what: "reconciliation",
    },
  );
}
