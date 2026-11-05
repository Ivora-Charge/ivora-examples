import { formatMinorAmount } from "@/lib/locations/pricing";
import type { PaymentSummary } from "./actions";

const REVIEW_TEXT: Record<string, string> = {
  cdr_above_hold: "CDR above the hold: the hold was captured, the rest was not",
  hold_expired: "The hold expired before the CDR: nothing was charged",
  currency_mismatch:
    "CDR in another currency than the hold: nothing charged yet",
  vat_unknown:
    "The CDR gave no amount incl. VAT: the amount excl. VAT was captured",
  increment_declined:
    "A raise of the hold was refused; the session was stopped",
  credit_cdr: "The CPO sent a credit CDR: refund the driver if owed",
  hold_unknown: "Stripe never answered the hold; the webhook cancels any hold",
  dispute: "The driver disputed the charge with their bank",
  refund_outside: "Money moved outside this server (the Stripe Dashboard)",
  second_cdr:
    "Another CDR came for this charge: compare it with the one settled (see the audit log)",
};

export function PaymentFacts({ p }: { p: PaymentSummary }) {
  const rows: [string, string | number | null][] = [
    ["Payment", p.id],
    ["Charge", p.commandId],
    ["Driver", p.driverRef],
    ["Status", p.status],
    ["Hold", formatMinorAmount(p.holdAmount, p.currency)],
    ["Authorised", formatMinorAmount(p.authorizedAmount, p.currency)],
    ["Captured", formatMinorAmount(p.capturedAmount, p.currency)],
    ["Refunded", formatMinorAmount(p.refundedAmount, p.currency)],
    [
      "CDR total",
      p.cdrAmount === null
        ? null
        : formatMinorAmount(p.cdrAmount, p.cdrCurrency ?? p.currency),
    ],
    [
      "Not charged",
      p.shortfallAmount
        ? formatMinorAmount(p.shortfallAmount, p.currency)
        : null,
    ],
    ["Review", p.review ? (REVIEW_TEXT[p.review] ?? p.review) : null],
    ["Reviewed", p.reviewedAt],
    ["Stopped", p.stopReason],
    ["Note", p.error || null],
    ["Created", p.createdAt],
  ];
  return (
    <div className="peer">
      <dl className="facts">
        {rows
          .filter(([, v]) => v !== null && v !== "")
          .map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{k}</dt>
              <dd>
                {k === "Payment" || k === "Charge" ? <code>{v}</code> : v}
              </dd>
            </div>
          ))}
      </dl>
      {p.refunds?.map((r) => (
        <p key={r.id} className="muted">
          Refund {formatMinorAmount(r.amount, p.currency)}: {r.status}
          {r.reason ? ` (${r.reason})` : ""}, by {r.actor} at {r.createdAt}
        </p>
      ))}
    </div>
  );
}
